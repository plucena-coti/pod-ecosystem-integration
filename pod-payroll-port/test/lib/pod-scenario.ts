import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { createWalletClient, custom, bytesToHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { connectDualChainForTests, onboardSimUser, registerUserOnSim } from "../../../test/sim-coti/sim-coti-utils.js";
import {
  fundContractForInboxFees,
  setupContext,
  normalizePrivateKey,
  isSimCotiBackend,
  podTwoWayWriteOptions,
  receiptWaitOptions,
} from "../../../test/system/mpc-test-utils.js";
import { completePodOpRoundTrip } from "../../../test/tokens/test-token-utils.js";
import { buildSablierTree, setPodMerkleContext, takeTreeByRoot, type ClaimPackage, type SablierMerkleTree } from "./merkle.js";
import { spLog } from "./utils.js";
import { PodPayrollBackendImpl } from "./pod-backend.js";
import { patchSablierDeploy, wrapCampaignFacade, type CampaignContract } from "./campaign-facade.js";
import { setupPayrollPortal, seedCorporateTreasury, portalDepositTo } from "./portal-setup.js";
import { createPayrollTokenAdapter, type StoryToken } from "./pod-token-adapter.js";

export type Account = {
  address: Address;
  wallet: WalletClient;
  label: string;
};

export type SablierPayrollScenario = {
  viem: Awaited<ReturnType<typeof connectDualChainForTests>>["sepoliaViem"];
  publicClient: PublicClient;
  employer: Account;
  employees: Account[];
  alice: Account;
  bob: Account;
  carol: Account;
  admin: Account;
  token: StoryToken;
  comptroller: { address: Address; read: Record<string, (...args: unknown[]) => Promise<unknown>>; write: Record<string, (...args: unknown[]) => Promise<Hex>> };
  campaign: CampaignContract;
  merkle: typeof buildSablierTree;
  freshCampaign: (opts: FreshCampaignOpts) => Promise<{
    tree: SablierMerkleTree;
    campaign: SablierPayrollScenario["campaign"];
    fundAmount: bigint;
  }>;
  podBackend: PodPayrollBackendImpl;
};

export type FreshCampaignOpts = {
  roster: { recipient: Address; amount: bigint }[];
  fundAmount?: bigint;
  campaignStartTime?: number;
  expiration?: number;
  minFeeUSD?: bigint;
};

const FACADE_PATH =
  "contracts/pod-payroll-port/avax/PayrollCampaignFacade.sol:PayrollCampaignFacade";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

function collectHardhatPrivateKeys(): Hex[] {
  const raw = [
    process.env.PRIVATE_KEY?.trim(),
    process.env.COTI_TESTNET_PRIVATE_KEY?.trim(),
    process.env._PRIVATE_KEY?.trim(),
    process.env.PRIVATE_KEY_ACCOUNT_2?.trim(),
    process.env.SEPOLIA_PRIVATE_KEY?.trim(),
  ].filter((k): k is string => !!k);
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const key of raw) {
    const normalized = (key.startsWith("0x") ? key : `0x${key}`).toLowerCase() as Hex;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  if (out.length > 0) return out;
  return Array.from({ length: 20 }, (_, i) => {
    const account = mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: i });
    return bytesToHex(account.getHdKey().privateKey!) as Hex;
  });
}

function mnemonicPrivateKey(index: number): Hex {
  const account = mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: index });
  return bytesToHex(account.getHdKey().privateKey!) as Hex;
}

function privateKeyForAddress(address: Address): Hex {
  const fromEnv = collectHardhatPrivateKeys().find(
    (k) => privateKeyToAccount(k).address.toLowerCase() === address.toLowerCase()
  );
  if (fromEnv) return fromEnv;
  for (let i = 0; i < 20; i++) {
    const pk = mnemonicPrivateKey(i);
    if (privateKeyToAccount(pk).address.toLowerCase() === address.toLowerCase()) {
      return pk;
    }
  }
  throw new Error(`no private key for ${address}`);
}

async function walletForMnemonicIndex(
  publicClient: PublicClient,
  funder: WalletClient,
  index: number
): Promise<WalletClient> {
  const account = mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: index });
  await funder.sendTransaction({ to: account.address, value: 2n * 10n ** 18n });
  return createWalletClient({
    account,
    chain: publicClient.chain,
    transport: custom({ request: (args) => publicClient.request(args) }),
  });
}

async function onboardByAddress(
  cotiViem: Awaited<ReturnType<typeof connectDualChainForTests>>["cotiViem"],
  address: Address,
  userKeys: Map<string, string>,
  cotiFunderWallet: WalletClient
): Promise<void> {
  const lower = address.toLowerCase();
  if (userKeys.has(lower)) return;
  const pk = privateKeyForAddress(address);
  const inEnv = collectHardhatPrivateKeys().some(
    (k) => privateKeyToAccount(k).address.toLowerCase() === lower
  );
  if (!inEnv && isSimCotiBackend()) {
    await cotiFunderWallet.sendTransaction({ to: address, value: 2n * 10n ** 18n });
  }
  const { userKey } = await onboardSimUser(cotiViem, pk);
  userKeys.set(lower, userKey);
}

export async function createSablierPayrollScenario(): Promise<SablierPayrollScenario> {
  const nets = await connectDualChainForTests();
  const { sepoliaViem, cotiViem } = nets;
  const publicClient = await sepoliaViem.getPublicClient();
  const podCtx = await setupContext({ sepoliaViem, cotiViem });

  setPodMerkleContext({ userKey: podCtx.crypto.userKey });

  const wallets = await sepoliaViem.getWalletClients();
  const employerWallet = wallets[0];
  const aliceWallet = wallets[1] ?? wallets[0];
  const bobWallet = wallets[2] ?? wallets[0];
  const carolWallet =
    wallets[3] ?? (await walletForMnemonicIndex(publicClient, employerWallet, 3));
  if (!wallets[3]) {
    await publicClient.request({
      method: "hardhat_impersonateAccount",
      params: [carolWallet.account.address],
    } as never);
  }
  const adminWallet = wallets[0];

  const employer: Account = { address: employerWallet.account.address, wallet: employerWallet, label: "employer" };
  const alice: Account = { address: aliceWallet.account.address, wallet: aliceWallet, label: "alice" };
  const bob: Account = { address: bobWallet.account.address, wallet: bobWallet, label: "bob" };
  const carol: Account = { address: carolWallet.account.address, wallet: carolWallet, label: "carol" };
  const admin: Account = { address: adminWallet.account.address, wallet: adminWallet, label: "admin" };

  const comptroller = await sepoliaViem.deployContract(
    "contracts/pod-payroll-port/mocks/MockSablierComptroller.sol:MockSablierComptroller",
    [0n]
  );

  const cotiPk = normalizePrivateKey(
    process.env.PRIVATE_KEY?.trim() ||
      process.env.COTI_TESTNET_PRIVATE_KEY?.trim() ||
      process.env._PRIVATE_KEY?.trim() ||
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  ) as Hex;
  const cotiOwner = privateKeyToAccount(cotiPk).address;

  const portalCtx = await setupPayrollPortal({
    sepoliaViem,
    cotiViem,
    podCtx,
    cotiOwnerPk: cotiPk,
  });

  const userKeys = new Map<string, string>();
  userKeys.set(cotiOwner.toLowerCase(), podCtx.crypto.userKey);

  const cotiPayroll = await cotiViem.deployContract(
    "contracts/pod-payroll-port/coti/PrivatePayrollCoti.sol:PrivatePayrollCoti",
    [podCtx.contracts.inboxCoti.address, cotiOwner],
    {
      client: { public: podCtx.coti.publicClient, wallet: podCtx.coti.wallet },
    } as never
  );

  const payrollVault = await sepoliaViem.deployContract(
    "contracts/pod-payroll-port/avax/PayrollVault.sol:PayrollVault",
    [podCtx.contracts.inboxSepolia.address, cotiPayroll.address]
  );

  const claimStore = await sepoliaViem.deployContract(
    "contracts/pod-payroll-port/avax/PodClaimStore.sol:PodClaimStore",
    []
  );

  await fundContractForInboxFees(adminWallet, publicClient, payrollVault.address as Address, 5n * 10n ** 18n);

  const gasPrice = await publicClient.getGasPrice();
  const [payrollTargetWei, payrollCallerWei] = (await podCtx.contracts.inboxSepolia.read.calculateTwoWayFeeRequiredInLocalToken([
    4096n,
    4096n,
    600_000n,
    600_000n,
    gasPrice,
  ])) as [bigint, bigint];
  const padFee = (x: bigint) => x + x / 5n + 1n;
  const callbackFeeWei = padFee(payrollCallerWei);
  const inboxFeeWei = padFee(payrollTargetWei + payrollCallerWei);
  const pTokenTransferFeeWei = padFee(portalCtx.base.podTwoWayFees.totalValueWei);
  const pTokenCallbackFeeWei = padFee(portalCtx.base.podTwoWayFees.callbackFeeWei);

  await payrollVault.write.setInboxFees([inboxFeeWei, callbackFeeWei], { account: admin.address });
  await payrollVault.write.configure(
    ["0x0000000000000000000000000000000000000000", podCtx.contracts.mpcExecutor.address, podCtx.chainIds.coti],
    { account: admin.address }
  );

  await onboardByAddress(cotiViem, employer.address, userKeys, podCtx.coti.wallet);
  for (const acct of [alice, bob, carol]) {
    await onboardByAddress(cotiViem, acct.address, userKeys, podCtx.coti.wallet);
  }

  await employerWallet.sendTransaction({
    to: employer.address,
    value: 10n * 10n ** 18n,
  });

  await seedCorporateTreasury(portalCtx, employer.address);

  const payrollFacades = new Set<string>();

  async function fundCampaignOnFacade(
    facade: Address,
    amount: bigint,
    account: Address
  ): Promise<Hex> {
    const facadeContract = await sepoliaViem.getContractAt(FACADE_PATH, facade);
    const itAmount = await tokenAdapterRef.buildTransferIt(account, amount);
    const fees = portalCtx.base.podTwoWayFees;
    const hash = await (
      facadeContract as { write: { fundCampaign: (...args: unknown[]) => Promise<Hex> } }
    ).write.fundCampaign([itAmount, amount], {
      account,
      ...podTwoWayWriteOptions(fees),
    });
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    await completePodOpRoundTrip(portalCtx, `fund-${facade.slice(0, 10)}`, async () => hash);
    await employerWallet.sendTransaction({
      to: facade,
      value: 5n * 10n ** 18n,
    });
    return hash;
  }

  let tokenAdapterRef!: ReturnType<typeof createPayrollTokenAdapter>;

  const tokenAdapter = createPayrollTokenAdapter({
    portalCtx,
    publicClient,
    userKeys,
    defaultUserKey: podCtx.crypto.userKey,
    topUpTreasury: (treasury, amount, label) => portalDepositTo(portalCtx, treasury, amount, label),
    isPayrollFacade: (facade) => payrollFacades.has(facade.toLowerCase()),
    fundCampaign: (facade, amount, account) => fundCampaignOnFacade(facade, amount, account),
  });
  tokenAdapterRef = tokenAdapter;

  const podBackend = new PodPayrollBackendImpl(
    podCtx,
    portalCtx,
    publicClient,
    cotiPayroll,
    payrollVault,
    claimStore,
    adminWallet,
    callbackFeeWei,
    pTokenTransferFeeWei,
    pTokenCallbackFeeWei,
    cotiPk,
    tokenAdapter
  );

  const deployContractOrig = sepoliaViem.deployContract.bind(sepoliaViem);

  async function registerPodCampaign(
    facade: CampaignContract,
    tree: SablierMerkleTree,
    runId: number
  ): Promise<void> {
    await cotiPayroll.write.registerRun([BigInt(runId), tree.root], {
      account: cotiOwner,
      client: { public: podCtx.coti.publicClient, wallet: podCtx.coti.wallet },
    } as never);

    for (const pkg of tree.packages) {
      const itAmount = await podBackend.buildItAmount(pkg.amount, "register");
      await cotiPayroll.write.registerLeaf(
        [BigInt(runId), BigInt(pkg.index), pkg.recipient, pkg.amountCommitment!, itAmount],
        {
          account: cotiOwner,
          client: { public: podCtx.coti.publicClient, wallet: podCtx.coti.wallet },
        } as never
      );
      await facade.write.registerLeaf(
        [BigInt(pkg.index), pkg.recipient, pkg.amount, pkg.amountCommitment!],
        { account: admin.address }
      );
    }
  }

  async function fundFacade(facade: CampaignContract, amount: bigint): Promise<void> {
    await registerUserOnSim(cotiViem, facade.address, podCtx.crypto.userKey);
    userKeys.set(facade.address.toLowerCase(), podCtx.crypto.userKey);
    payrollFacades.add(facade.address.toLowerCase());
    await tokenAdapter.token.write.transfer([facade.address, amount], {
      account: employer.address,
    });
  }

  async function deployFacadeHarness(args: unknown[]): Promise<CampaignContract> {
    const [
      adminAddr,
      comptrollerAddr,
      merkleRoot,
      tokenAddr,
      campaignStartTime,
      expiration,
      campaignName,
      minFeeUSD,
    ] = args as [Address, Address, Hex, Address, number, number, string, bigint];

    const facade = await deployContractOrig(FACADE_PATH, [
      adminAddr,
      comptrollerAddr,
      merkleRoot,
      tokenAddr,
      campaignStartTime,
      expiration,
      campaignName,
      minFeeUSD,
    ]);

    const runIdBefore = Number(await payrollVault.read.nextRunId());
    await payrollVault.write.createRun(
      [merkleRoot, tokenAddr, facade.address, campaignStartTime, expiration],
      { account: admin.address }
    );
    const actualRunId = runIdBefore;

    await facade.write.wirePayroll(
      [
        payrollVault.address,
        claimStore.address,
        BigInt(actualRunId),
        callbackFeeWei,
        inboxFeeWei,
        pTokenTransferFeeWei,
        pTokenCallbackFeeWei,
      ],
      { account: admin.address }
    );

    const tree = takeTreeByRoot(merkleRoot);
    if (tree) {
      await registerPodCampaign(facade as CampaignContract, tree, actualRunId);
    }

    await registerUserOnSim(cotiViem, facade.address, podCtx.crypto.userKey);
    userKeys.set(facade.address.toLowerCase(), podCtx.crypto.userKey);
    payrollFacades.add(facade.address.toLowerCase());

    return facade as CampaignContract;
  }

  patchSablierDeploy(sepoliaViem, podBackend, async (args) => {
    const raw = await deployFacadeHarness(args);
    return wrapCampaignFacade(raw, podBackend);
  });

  async function freshCampaign(opts: FreshCampaignOpts) {
    const rosterEntries = opts.roster.map((r, i) => ({
      index: i,
      recipient: r.recipient,
      amount: r.amount,
    }));
    const tree = buildSablierTree(rosterEntries);
    const now = Number((await publicClient.getBlock()).timestamp);
    const campaignStartTime = opts.campaignStartTime ?? now - 60;
    const expiration = opts.expiration ?? 0;
    const minFeeUSD = opts.minFeeUSD ?? 0n;
    const fundAmount = opts.fundAmount ?? rosterEntries.reduce((s, e) => s + e.amount, 0n);

    const rawFacade = await deployFacadeHarness([
      admin.address,
      comptroller.address,
      tree.root,
      tokenAdapter.token.address,
      campaignStartTime,
      expiration,
      "Q1 Payroll",
      minFeeUSD,
    ]);

    const campaign = wrapCampaignFacade(rawFacade, podBackend);

    await fundFacade(campaign, fundAmount);

    spLog(`campaign=${campaign.address} root=${tree.root} funded=${fundAmount} from treasury`);
    return { tree, campaign, fundAmount };
  }

  const placeholderRaw = await deployFacadeHarness([
    admin.address,
    comptroller.address,
    `0x${"00".repeat(32)}` as Hex,
    tokenAdapter.token.address,
    0,
    0,
    "placeholder",
    0n,
  ]);
  const placeholder = wrapCampaignFacade(placeholderRaw, podBackend);

  spLog(
    `deployed pToken=${tokenAdapter.token.address} portal=${portalCtx.portal.address} vault=${payrollVault.address}`
  );

  return {
    viem: sepoliaViem,
    publicClient,
    employer,
    employees: [alice, bob, carol],
    alice,
    bob,
    carol,
    admin,
    token: tokenAdapter.token,
    comptroller,
    campaign: placeholder,
    merkle: buildSablierTree,
    freshCampaign,
    podBackend,
  };
}

export type { ClaimPackage, SablierMerkleTree };
