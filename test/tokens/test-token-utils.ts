import assert from "node:assert/strict";
import { network } from "hardhat";
import { JsonRpcProvider } from "ethers";
import { privateKeyToAccount } from "viem/accounts";
import { decryptUint, prepareIT256 } from "@coti-io/coti-sdk-typescript";
import { ONBOARD_CONTRACT_ADDRESS, transferNative, Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { createWalletClient, custom, encodeFunctionData, decodeAbiParameters, parseAbi, parseEther, toFunctionSelector, toHex } from "viem";
import {
  buildEncryptedInput256,
  decodeCtUint256,
  decryptUint256,
  fundContractForInboxFees,
  getLatestRequest,
  getResponseRequestBySource,
  logStep,
  mineRequest,
  normalizePrivateKey,
  onboardUser,
  receiptWaitOptions,
  requireEnv,
  resolveCotiTestnetPrivateKey,
  runCrossChainTwoWayRoundTrip,
  setupContext,
  podTwoWayWriteOptions,
  type MineRequestOptions,
  type TestContext,
} from "../system/mpc-test-utils.js";
import { isSimCotiBackend } from "../sim-coti/sim-coti-utils.js";

/**
 * Gas for COTI `batchProcessRequests` in pod-token tests (`syncBalances` runs `offBoardToUser` per account in one tx).
 * Default is above wide MPC default to reduce OOG on testnet; override with `COTI_MINE_GAS_POD_TOKEN`.
 */
const DEFAULT_COTI_MINE_GAS_POD_TOKEN = 80_000_000n;

export function getDefaultCotiMineGasPodToken(): bigint {
  const raw = process.env.COTI_MINE_GAS_POD_TOKEN?.trim();
  if (!raw) return DEFAULT_COTI_MINE_GAS_POD_TOKEN;
  try {
    return BigInt(raw);
  } catch {
    return DEFAULT_COTI_MINE_GAS_POD_TOKEN;
  }
}

export type PodTokenTestContext = {
  base: TestContext;
  /** Deployed as `PodErc20Mintable` with `owner` set as the minter so mint tests can exercise the access-control path. */
  pod: any;
  /** Same Hardhat `PodErc20Mintable` instance, wallet = COTI-funded owner (cross-chain test pattern). */
  podAsCoti: any;
  /** Same Hardhat pToken, wallet = Bob (for concurrent-sender / receiver-not-locked cases). */
  podAsBob: any;
  podCotiMother: any;
  owner: `0x${string}`;
  bob: { address: `0x${string}`; privateKey: `0x${string}`; userKey: string; wallet: CotiWallet };
};

const deriveSecondaryPrivateKey = (primaryKey: string) => {
  return derivePrivateKeyVariant(primaryKey, 0x01);
};

/** Derive a deterministic secondary EOA from the primary COTI key (xor last byte). */
export function derivePrivateKeyVariant(primaryKey: string, xorLastByte: number): `0x${string}` {
  const normalized = normalizePrivateKey(primaryKey).slice(2);
  const bytes = Buffer.from(normalized, "hex");
  bytes[bytes.length - 1] ^= xorLastByte & 0xff;
  return `0x${bytes.toString("hex")}`;
};

/** Funds a COTI account from the primary wallet; does not onboard. */
export async function fundCotiNativeAccount(params: {
  funderPrivateKey: string;
  recipient: `0x${string}`;
  amountWei?: bigint;
}): Promise<void> {
  const cotiRpcUrl = requireEnv("COTI_TESTNET_RPC_URL");
  const amountWei = params.amountWei ?? 1_000_000_000_000_000_000n;
  const provider = new JsonRpcProvider(cotiRpcUrl) as any;
  const fundingWallet = new CotiWallet(normalizePrivateKey(params.funderPrivateKey), provider);
  let funded = false;
  for (let attempt = 0; attempt < 4 && !funded; attempt++) {
    if (attempt > 0) {
      logStep(`fundCotiNativeAccount retry ${attempt}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    try {
      const tx = await transferNative(provider, fundingWallet, params.recipient, amountWei, 100_000);
      funded = !!tx;
    } catch (e) {
      logStep(`fundCotiNativeAccount failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!funded) {
    throw new Error(`Failed to fund ${params.recipient} on COTI`);
  }
}

/** Funded COTI EOA without AES onboarding — for late-onboard transfer/approve tests. */
export async function setupFundedUnonboardedUser(
  primaryPrivateKey: string,
  xorLastByte: number
): Promise<{ address: `0x${string}`; privateKey: `0x${string}`; wallet: CotiWallet }> {
  const cotiRpcUrl = requireEnv("COTI_TESTNET_RPC_URL");
  const privateKey = derivePrivateKeyVariant(primaryPrivateKey, xorLastByte);
  const provider = new JsonRpcProvider(cotiRpcUrl) as any;
  const wallet = new CotiWallet(privateKey, provider);
  await fundCotiNativeAccount({
    funderPrivateKey: primaryPrivateKey,
    recipient: wallet.address as `0x${string}`,
  });
  return { address: wallet.address as `0x${string}`, privateKey, wallet };
}

/** Funds and onboards a second account (Bob) for balance decryption on transfers. */
export async function setupBobUser(
  primaryPrivateKey: string,
  opts?: { cotiViem?: any }
): Promise<{
  address: `0x${string}`;
  privateKey: `0x${string}`;
  userKey: string;
  wallet: CotiWallet;
}> {
  const simBackend = isSimCotiBackend();
  const cotiRpcUrl = simBackend
    ? process.env.SIM_COTI_RPC_URL || process.env.COTI_TESTNET_RPC_URL || "http://127.0.0.1:8546"
    : requireEnv("COTI_TESTNET_RPC_URL");
  const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;
  const normalizedKey = deriveSecondaryPrivateKey(primaryPrivateKey);
  const bobAccount = privateKeyToAccount(normalizedKey);
  const provider = new JsonRpcProvider(cotiRpcUrl) as any;
  const fundingWallet = new CotiWallet(normalizePrivateKey(primaryPrivateKey), provider);
  const wallet = new CotiWallet(normalizedKey, provider);

  if (!simBackend) {
    const balance = await provider.getBalance(wallet.address);
    const minBalance = 300_000_000_000_000_000n;
    if (balance < minBalance) {
      logStep("Funding Bob for COTI onboarding");
      let funded = false;
      for (let attempt = 0; attempt < 4 && !funded; attempt++) {
        if (attempt > 0) {
          logStep(`Bob funding retry ${attempt} (nonce / fee)`);
          await new Promise((r) => setTimeout(r, 5_000));
        }
        try {
          const tx = await transferNative(
            provider,
            fundingWallet,
            wallet.address,
            1_000_000_000_000_000_000n,
            100_000
          );
          funded = !!tx;
        } catch (e) {
          logStep(`Bob funding attempt failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!funded) {
        throw new Error("Failed to fund Bob after retries.");
      }
    }

    const fundedBalance = await provider.getBalance(wallet.address);
    if (fundedBalance < minBalance) {
      throw new Error(`Bob balance still too low: ${fundedBalance}`);
    }
  }

  const userKey = await onboardUser(normalizedKey, cotiRpcUrl, onboardAddress, "COTI_AES_KEY_BOB");
  if (simBackend) {
    const { registerUserOnSim } = await import("../sim-coti/sim-coti-utils.js");
    const cotiViem =
      opts?.cotiViem ?? (await network.connect({ network: "simCoti" })).viem;
    // Owner (Hardhat #0) signs the simRegisterUserKey write for Bob.
    const [signer] = await cotiViem.getWalletClients();
    await registerUserOnSim(cotiViem, bobAccount.address, userKey, signer.account);
    logStep(`simCoti: registered Bob AES key for ${bobAccount.address}`);
  }
  wallet.setAesKey(userKey);
  return {
    address: bobAccount.address,
    privateKey: normalizedKey,
    userKey,
    wallet,
  };
}

/** Inbox + miners + `PodERC20` on Hardhat + `PodErc20CotiMother` on COTI with factory registration. */
export async function setupPodTokenTestContext(params: {
  sepoliaViem: any;
  cotiViem: any;
}): Promise<PodTokenTestContext> {
  const base = await setupContext(params);

  const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey());
  const cotiAccount = privateKeyToAccount(cotiPk as `0x${string}`);
  const owner = cotiAccount.address;
  const hardhatCotiWallet = await params.sepoliaViem.getWalletClient(owner);

  logStep("Deploying PodErc20CotiMother on COTI");
  const podCotiMother = await params.cotiViem.deployContract(
    "PodErc20CotiMother",
    [base.contracts.inboxCoti.address, owner],
    { client: { public: base.coti.publicClient, wallet: base.coti.wallet } } as any
  );

  logStep("Deploying PodErc20Mintable on Hardhat (minter = owner)");
  const pod = await params.sepoliaViem.deployContract("PodErc20Mintable", [
    owner,
    base.chainIds.coti,
    base.contracts.inboxSepolia.address,
    podCotiMother.address,
    "PoD Test Token",
    "PODT",
  ]);

  await fundContractForInboxFees(hardhatCotiWallet, base.sepolia.publicClient, pod.address as `0x${string}`);

  await registerPodTokenOnMother({
    base,
    mother: podCotiMother,
    pTokenAddress: pod.address,
    registrar: owner,
    name: "PoD Test Token",
    symbol: "PODT",
    decimals: 18,
  });

  const podAsCoti = await params.sepoliaViem.getContractAt("PodErc20Mintable", pod.address, {
    client: { public: base.sepolia.publicClient, wallet: hardhatCotiWallet },
  });

  const bob = await setupBobUser(cotiPk, { cotiViem: params.cotiViem });
  const bobAccount = privateKeyToAccount(bob.privateKey);
  const hardhatTransport = custom({
    request: (args) => base.sepolia.publicClient.request(args),
  });
  const [hardhatFunder] = await params.sepoliaViem.getWalletClients();
  const bobHardhatBalance = await base.sepolia.publicClient.getBalance({ address: bob.address });
  if (bobHardhatBalance < parseEther("0.5")) {
    const fundHash = await hardhatFunder.sendTransaction({ to: bob.address, value: parseEther("1") });
    await base.sepolia.publicClient.waitForTransactionReceipt({ hash: fundHash, ...receiptWaitOptions });
  }
  const bobHardhatWallet = createWalletClient({
    account: bobAccount,
    chain: base.sepolia.publicClient.chain,
    transport: hardhatTransport,
  });
  const podAsBob = await params.sepoliaViem.getContractAt("PodErc20Mintable", pod.address, {
    client: { public: base.sepolia.publicClient, wallet: bobHardhatWallet },
  });

  logStep("Pod token setup complete");
  return { base, pod, podAsCoti, podAsBob, podCotiMother, owner, bob };
}

/** Native wei for `sendOneWayMessage` registration (matches `PrivacyPortalFactory.createPortal` default). */
export const POD_TOKEN_ONE_WAY_REGISTRATION_FEE_WEI = 2_500_000_000_000n;

/** Registers a source-chain pToken namespace on the COTI mother via a mined one-way inbox message. */
export async function registerPodTokenOnMother(params: {
  base: TestContext;
  mother: any;
  pTokenAddress: `0x${string}`;
  registrar: `0x${string}`;
  name?: string;
  symbol?: string;
  decimals?: number;
}) {
  const { base, mother, pTokenAddress, registrar } = params;
  const name = params.name ?? "PoD Test Token";
  const symbol = params.symbol ?? "PODT";
  const decimals = params.decimals ?? 18;

  await params.mother.write.setAllowedFactory(
    [BigInt(base.chainIds.sepolia), registrar, true],
    { account: params.base.coti.wallet.account }
  );

  const data = encodeFunctionData({
    abi: parseAbi([
      "function registerToken(address remotePToken, string name, string symbol, uint8 decimals)",
    ]),
    functionName: "registerToken",
    args: [pTokenAddress, name, symbol, decimals],
  });

  const hash = await base.contracts.inboxSepolia.write.sendOneWayMessage(
    [
      base.chainIds.coti,
      mother.address,
      {
        selector: "0x00000000",
        data,
        datatypes: [],
        datalens: [],
      },
      "0x00000000",
    ],
    {
      account: registrar,
      value: POD_TOKEN_ONE_WAY_REGISTRATION_FEE_WEI,
      // eth_estimateGas simulates without msg.value; inbox rejects TotalFeeTooLow(0) during estimation.
      gas: 800_000n,
    }
  );
  await base.sepolia.publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });

  const outboundRequest = await getLatestRequest(base.contracts.inboxSepolia, base.chainIds.coti);
  await mineRequest(
    base,
    "coti",
    BigInt(base.chainIds.sepolia),
    outboundRequest,
    "registerPodToken",
    { gas: getDefaultCotiMineGasPodToken() }
  );

  const registered = await mother.read.isRegistered([BigInt(base.chainIds.sepolia), pTokenAddress]);
  assert.ok(registered, "pToken not registered on COTI mother");
}

/** Mints on COTI via the pToken minter inbox path (`mintPublic` on the mother). No-op for `amount == 0`. */
export async function mintOnCoti(
  ctx: PodTokenTestContext,
  to: `0x${string}`,
  amount: bigint
): Promise<void> {
  if (amount === 0n) {
    return;
  }
  await completePodOpRoundTrip(ctx, "mintOnCoti", () =>
    ctx.podAsCoti.write.mint(
      [to, amount, ctx.base.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.base.podTwoWayFees)
    )
  );
}

/** Runs `syncBalances` from PoD and completes COTI + Hardhat mining (pulls ciphertext to Sepolia). */
export async function syncPodBalancesRoundTrip(
  ctx: PodTokenTestContext,
  accounts: readonly `0x${string}`[],
  label: string,
  mineOptions?: MineRequestOptions
): Promise<ReturnType<typeof runCrossChainTwoWayRoundTrip>> {
  const txHash = await ctx.podAsCoti.write.syncBalances(
    [[...accounts], ctx.base.podTwoWayFees.callbackFeeWei],
    podTwoWayWriteOptions(ctx.base.podTwoWayFees)
  );
  await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
  return runCrossChainTwoWayRoundTrip(ctx.base, label, {
    ...mineOptions,
    gas: mineOptions?.gas ?? getDefaultCotiMineGasPodToken(),
  });
}

/**
 * Sends a PoD-side two-way tx (`transfer`, `approve`, …), then mines COTI and the return leg on Hardhat.
 */
export async function completePodOpRoundTrip(
  ctx: PodTokenTestContext,
  label: string,
  send: () => Promise<`0x${string}`>,
  mineOptions?: MineRequestOptions
): Promise<ReturnType<typeof runCrossChainTwoWayRoundTrip>> {
  const txHash = await send();
  await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
  return runCrossChainTwoWayRoundTrip(ctx.base, label, {
    ...mineOptions,
    gas: mineOptions?.gas ?? getDefaultCotiMineGasPodToken(),
  });
}

export function userKeyForAccount(ctx: PodTokenTestContext, account: `0x${string}`): string {
  if (account.toLowerCase() === ctx.owner.toLowerCase()) {
    return ctx.base.crypto.userKey;
  }
  if (account.toLowerCase() === ctx.bob.address.toLowerCase()) {
    return ctx.bob.userKey;
  }
  throw new Error(`No AES key configured for ${account}`);
}

/** Uninitialized PoD `_balances` is `(0,0)`; COTI may already hold garbled zero before the first mirrored nonce. */
const isUninitializedPodBalanceCt = (ct: unknown): boolean => {
  const { ciphertextHigh, ciphertextLow } = decodeCtUint256(ct);
  return ciphertextHigh === 0n && ciphertextLow === 0n;
};

/** Decrypts `PodERC20.balanceOf(account)` using the matching onboarded user key. */
export async function readDecryptedBalance(
  ctx: PodTokenTestContext,
  account: `0x${string}`
): Promise<bigint> {
  const ct = await ctx.pod.read.balanceOf([account]);
  if (isUninitializedPodBalanceCt(ct)) {
    return 0n;
  }
  return decryptUint256(ct, userKeyForAccount(ctx, account), decryptUint);
}

/** Reads `balanceOfWithStatus` and returns `{ balance, pending }`. */
export async function readBalanceWithPending(
  ctx: PodTokenTestContext,
  account: `0x${string}`
): Promise<{ balance: bigint; pending: boolean }> {
  const [ct, pending] = await ctx.pod.read.balanceOfWithStatus([account]);
  const balance = isUninitializedPodBalanceCt(ct)
    ? 0n
    : decryptUint256(ct, userKeyForAccount(ctx, account), decryptUint);
  return { balance, pending };
}

export async function readDecryptedAllowance(
  ctx: PodTokenTestContext,
  owner: `0x${string}`,
  spender: `0x${string}`
): Promise<{ ownerCt: bigint; spenderCt: bigint }> {
  const allowance = await ctx.pod.read.allowance([owner, spender]);
  const ownerCt = getAllowanceHalf(allowance, "owner");
  const spenderCt = getAllowanceHalf(allowance, "spender");
  const ownerKey = userKeyForAccount(ctx, owner);
  const spenderKey = userKeyForAccount(ctx, spender);
  return {
    ownerCt: decryptUint256(ownerCt, ownerKey, decryptUint),
    spenderCt: decryptUint256(spenderCt, spenderKey, decryptUint),
  };
}

function getAllowanceHalf(allowance: unknown, role: "owner" | "spender"): unknown {
  const field = role === "owner" ? "ownerCiphertext" : "spenderCiphertext";
  const tuple = allowance as Record<string, unknown>;
  return tuple[field] ?? tuple[role === "owner" ? 0 : 1];
}

export async function readAllowanceWithPending(
  ctx: PodTokenTestContext,
  owner: `0x${string}`,
  spender: `0x${string}`
): Promise<{ ownerPart: bigint; spenderPart: bigint; pending: boolean }> {
  const [allowance, pending] = await ctx.pod.read.allowanceWithStatus([owner, spender]);
  const ownerCt = getAllowanceHalf(allowance, "owner");
  const spenderCt = getAllowanceHalf(allowance, "spender");
  return {
    ownerPart: decryptUint256(ownerCt, userKeyForAccount(ctx, owner), decryptUint),
    spenderPart: decryptUint256(spenderCt, userKeyForAccount(ctx, spender), decryptUint),
    pending,
  };
}

/** `buildEncryptedInput256` against the shared test encrypt context. */
export function encryptAmount(ctx: PodTokenTestContext, amount: bigint) {
  return buildEncryptedInput256(ctx.base, amount);
}

/**
 * Encrypt+sign an amount with Bob's AES key / ECDSA key (for wrong-signer system-error tests).
 * Uses the same inbox `batchProcessRequests` selector as {@link buildEncryptedInput256}.
 */
export function encryptAmountAsBob(ctx: PodTokenTestContext, amount: bigint) {
  const functionSelector = toFunctionSelector(
    "batchProcessRequests(uint256,(bytes32,address,address,(bytes4,bytes,bytes8[],bytes32[]),bytes4,bytes4,bool,bytes32,uint256,uint256)[])"
  );
  const it = prepareIT256(
    amount,
    {
      wallet: ctx.bob.wallet as any,
      userKey: ctx.bob.userKey,
    },
    ctx.base.contracts.inboxCoti.address,
    functionSelector
  );
  const signature =
    typeof it.signature === "string"
      ? (it.signature as `0x${string}`)
      : toHex(it.signature as any);
  return {
    ciphertext: it.ciphertext,
    signature,
  };
}

/** UTF-8 string from app-raise `failedRequests` bytes (raw reason) or system {ErrorData}.message. */
export function utf8FromFailedRequestBytes(hex: `0x${string}`): string {
  if (!hex || hex === "0x") {
    return "";
  }
  try {
    const [, message] = decodeAbiParameters([{ type: "uint64" }, { type: "bytes" }], hex);
    const msgHex = message as `0x${string}`;
    if (!msgHex || msgHex === "0x") {
      return "";
    }
    return Buffer.from(msgHex.slice(2), "hex").toString("utf8");
  } catch {
    const slice = hex.startsWith("0x") ? hex.slice(2) : hex;
    return Buffer.from(slice, "hex").toString("utf8");
  }
}

/**
 * Mints on COTI then syncs listed accounts to PoD (one round trip).
 * Convenience for tests that start from a funded COTI ledger.
 */
export async function mintOnCotiAndSync(
  ctx: PodTokenTestContext,
  recipients: readonly { address: `0x${string}`; amount: bigint }[],
  label: string,
  mineOptions?: MineRequestOptions
): Promise<ReturnType<typeof runCrossChainTwoWayRoundTrip>> {
  for (const { address, amount } of recipients) {
    await mintOnCoti(ctx, address, amount);
  }
  const accounts = recipients.map((r) => r.address);
  return syncPodBalancesRoundTrip(ctx, accounts, label, mineOptions);
}

/** Mines the latest queued PoD→COTI message without sending a new PoD tx (e.g. clear a pending transfer). */
export async function mineLatestOutboundRoundTrip(
  ctx: PodTokenTestContext,
  label: string,
  mineOptions?: MineRequestOptions
): Promise<ReturnType<typeof runCrossChainTwoWayRoundTrip>> {
  return runCrossChainTwoWayRoundTrip(ctx.base, label, {
    ...mineOptions,
    gas: mineOptions?.gas ?? getDefaultCotiMineGasPodToken(),
  });
}

/** Mines a specific PoD→COTI outbound request (and its Hardhat return leg). Use when multiple are queued. */
export async function mineOutboundRoundTripForRequest(
  ctx: PodTokenTestContext,
  outboundRequest: Awaited<ReturnType<typeof getLatestRequest>>,
  label: string,
  mineOptions?: MineRequestOptions
): Promise<{ cotiIncomingRequestId: `0x${string}` }> {
  const gas = mineOptions?.gas ?? getDefaultCotiMineGasPodToken();
  const { requestIdUsed: cotiIncomingRequestId } = await mineRequest(
    ctx.base,
    "coti",
    BigInt(ctx.base.chainIds.sepolia),
    outboundRequest,
    label,
    { ...mineOptions, gas }
  );
  const returnLegRequest = await getResponseRequestBySource(
    ctx.base.contracts.inboxCoti,
    cotiIncomingRequestId,
    label
  );
  await mineRequest(ctx.base, "sepolia", ctx.base.chainIds.coti, returnLegRequest, label, {
    nonceOverride: mineOptions?.nonceOverride,
  });
  return { cotiIncomingRequestId };
}

export function assertIncludesInsensitive(haystack: string, needle: string) {
  assert.ok(
    haystack.toLowerCase().includes(needle.toLowerCase()),
    `expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`
  );
}
