// Approved production contracts deployed over an isolated local chain for SDK conformance.
import {
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  http,
  keccak256,
  parseAbiParameters,
  toBytes,
  zeroAddress,
} from 'viem';
import type { Abi, Account, Address, Hex, PrivateKeyAccount, TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readArtifact, startAnvil } from './anvil.ts';
import type { AnvilFixture, ContractArtifact } from './anvil.ts';

export const ADMIN_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const DELEGATE_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const BORROWER: Address = '0x00000000000000000000000000000000000000B0';

const PROXY_ADMIN: Address = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65';
const STANDBY_GUARDIAN: Address = '0x00000000000000000000000000000000000000c0';
const LLTV = 800_000_000_000_000_000n;
/** The gas limit of a fixture transaction, as a multiple of its estimate. */
const GAS_MARGIN = 2n;

export interface ActivationConfig {
  readonly minActivationDelay: number;
  readonly maxActivationDelay: number;
  readonly maxDelayInflow: bigint;
  readonly minDepositAmount: bigint;
  readonly activatingLockDuration: number;
  readonly minActivationAmount: bigint;
  readonly maxGuardiansQuorumDelay: number;
  readonly delayPerStrike: number;
  readonly delayPerSuspect: number;
}

export interface MarketFixture {
  readonly id: Hex;
  /** The proxy the core calls. */
  readonly controller: Address;
  /** The contract behind the proxy, whose runtime code the deployment size limit applies to. */
  readonly controllerImplementation: Address;
  readonly controllerAbi: Abi;
  readonly createReceipt: TransactionReceipt;
  supply(assets: bigint): Promise<TransactionReceipt>;
  supplyLoan(assets: bigint): Promise<TransactionReceipt>;
  borrow(assets: bigint): Promise<TransactionReceipt>;
  withdraw(assets: bigint): Promise<TransactionReceipt>;
  liquidate(seizedAssets: bigint): Promise<TransactionReceipt>;
  settle(borrowShares: bigint): Promise<TransactionReceipt>;
  position(): Promise<readonly [bigint, bigint, bigint]>;
  settlementFor(): Promise<readonly [readonly [bigint, bigint, bigint], readonly [bigint, bigint, bigint]]>;
  setActivationConfig(config: ActivationConfig): Promise<TransactionReceipt>;
  setInstantActivation(caller: Address, enabled: boolean): Promise<TransactionReceipt>;
  setPrice(price: bigint): Promise<TransactionReceipt>;
  setSettlementLtv(ltv: bigint): Promise<TransactionReceipt>;
}

export interface ProtocolFixture {
  readonly anvil: AnvilFixture;
  readonly admin: PrivateKeyAccount;
  readonly delegate: PrivateKeyAccount;
  readonly guardianSignals: Address;
  readonly guardianAbi: Abi;
  readonly core: Address;
  readonly coreAbi: Abi;
  readonly primaryMarket: MarketFixture;
  createMarket(): Promise<MarketFixture>;
  setDelegate(): Promise<TransactionReceipt>;
  removeAndReaddGuardian(): Promise<TransactionReceipt>;
  suspect(marketId: Hex, borrowers: readonly Address[]): Promise<TransactionReceipt>;
  flag(marketId: Hex, borrowers: readonly Address[]): Promise<TransactionReceipt>;
  unflag(marketId: Hex, borrowers: readonly Address[]): Promise<TransactionReceipt>;
  heartbeat(
    block: { readonly hash: Hex; readonly number: bigint; readonly timestamp: bigint },
    data: Hex,
  ): Promise<TransactionReceipt>;
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  minActivationDelay: 60,
  maxActivationDelay: 3_600,
  maxDelayInflow: 10_000n,
  minDepositAmount: 0n,
  activatingLockDuration: 0,
  minActivationAmount: 10n,
  maxGuardiansQuorumDelay: 0,
  delayPerStrike: 3_600,
  delayPerSuspect: 0,
};

/** Deploy the pinned Guardian registry and core plus one controlled market. */
export async function deployProtocolFixture(port: number): Promise<ProtocolFixture> {
  const anvil = await startAnvil(port);
  try {
    return await deployProtocol(anvil);
  } catch (error) {
    anvil.stop();
    throw error;
  }
}

async function deployProtocol(anvil: AnvilFixture): Promise<ProtocolFixture> {
  const admin = privateKeyToAccount(ADMIN_KEY);
  const delegate = privateKeyToAccount(DELEGATE_KEY);
  const wallet = createWalletClient({
    account: admin,
    chain: anvil.chain,
    transport: http(anvil.rpcUrl),
  });
  const delegateWallet = createWalletClient({
    account: delegate,
    chain: anvil.chain,
    transport: http(anvil.rpcUrl),
  });
  const guardianArtifact = readArtifact('GuardianSignals.json');
  const coreArtifact = readArtifact('Core.json');
  const proxyArtifact = readArtifact('OssifiableProxy.json');
  const deploy = deploymentWriter(anvil, wallet, admin);
  const write = contractWriter(anvil, wallet, admin);
  const writeSignal = contractWriter(anvil, delegateWallet, delegate);

  const guardianImplementation = await deploy(guardianArtifact);
  const guardianSignals = await deploy(proxyArtifact, [
    guardianImplementation,
    PROXY_ADMIN,
    encodeFunctionData({
      abi: guardianArtifact.abi,
      functionName: 'initialize',
      args: [admin.address, [admin.address], 1n],
    }),
  ]);
  await write(guardianSignals, guardianArtifact.abi, 'grantRole', [keccak256(toBytes('MANAGER_ROLE')), admin.address]);
  const coreImplementation = await deploy(coreArtifact);
  const core = await deploy(proxyArtifact, [
    coreImplementation,
    PROXY_ADMIN,
    encodeFunctionData({
      abi: coreArtifact.abi,
      functionName: 'initialize',
      args: [admin.address],
    }),
  ]);
  await authorizeBorrower(anvil, core, coreArtifact.abi, admin.address);

  const createMarket = () =>
    createMarketFixture(anvil, write, deploy, core, coreArtifact.abi, admin.address, guardianSignals);
  const primaryMarket = await createMarket();
  const setDelegate = () => write(guardianSignals, guardianArtifact.abi, 'setDelegate', [delegate.address]);
  const suspect = (marketId: Hex, borrowers: readonly Address[]) =>
    writeSignal(guardianSignals, guardianArtifact.abi, 'suspect', [marketId, admin.address, borrowers]);
  const flag = (marketId: Hex, borrowers: readonly Address[]) =>
    writeSignal(guardianSignals, guardianArtifact.abi, 'flag', [marketId, admin.address, borrowers]);
  const unflag = (marketId: Hex, borrowers: readonly Address[]) =>
    writeSignal(guardianSignals, guardianArtifact.abi, 'unflag', [marketId, admin.address, borrowers]);
  const heartbeat = (block: { readonly hash: Hex; readonly number: bigint; readonly timestamp: bigint }, data: Hex) =>
    writeSignal(guardianSignals, guardianArtifact.abi, 'heartbeat', [
      admin.address,
      [block.hash, block.number, block.timestamp],
      data,
    ]);
  const removeAndReaddGuardian = async (): Promise<TransactionReceipt> => {
    await write(guardianSignals, guardianArtifact.abi, 'addGuardian', [STANDBY_GUARDIAN]);
    await write(guardianSignals, guardianArtifact.abi, 'removeGuardian', [admin.address]);
    const readded = await write(guardianSignals, guardianArtifact.abi, 'addGuardian', [admin.address]);
    await write(guardianSignals, guardianArtifact.abi, 'removeGuardian', [STANDBY_GUARDIAN]);
    await setDelegate();
    return readded;
  };

  return {
    anvil,
    admin,
    delegate,
    guardianSignals,
    guardianAbi: guardianArtifact.abi,
    core,
    coreAbi: coreArtifact.abi,
    primaryMarket,
    createMarket,
    setDelegate,
    removeAndReaddGuardian,
    suspect,
    flag,
    unflag,
    heartbeat,
  };
}

type Deploy = (artifact: ContractArtifact, args?: readonly unknown[]) => Promise<Address>;
type Write = (
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
) => Promise<TransactionReceipt>;

function deploymentWriter(
  anvil: AnvilFixture,
  wallet: ReturnType<typeof createWalletClient>,
  account: PrivateKeyAccount,
): Deploy {
  return async function deploy(artifact, args = []) {
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
    const hash = await wallet.sendTransaction({ account, chain: anvil.chain, data });
    const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
      throw new Error('contract deployment returned no address');
    }
    return receipt.contractAddress;
  };
}

function contractWriter(
  anvil: AnvilFixture,
  wallet: ReturnType<typeof createWalletClient>,
  account: Account | Address,
): Write {
  return async function write(address, abi, functionName, args) {
    const data = encodeFunctionData({ abi, functionName, args });
    // Chain time follows the wall clock. When a second starts between the estimate and the block,
    // a time-dependent call costs more gas than estimated, so the limit leaves a margin.
    const estimatedGas = await anvil.publicClient.estimateGas({ account, to: address, data });
    const gas = estimatedGas * GAS_MARGIN;
    const hash = await wallet.sendTransaction({ account, chain: anvil.chain, to: address, data, gas });
    const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`${functionName} reverted in block ${String(receipt.blockNumber)}`);
    }
    return receipt;
  };
}

async function authorizeBorrower(anvil: AnvilFixture, core: Address, coreAbi: Abi, operator: Address): Promise<void> {
  await anvil.testClient.impersonateAccount({ address: BORROWER });
  await anvil.testClient.setBalance({ address: BORROWER, value: 10n ** 18n });
  const wallet = createWalletClient({
    account: BORROWER,
    chain: anvil.chain,
    transport: http(anvil.rpcUrl),
  });
  const data = encodeFunctionData({
    abi: coreAbi,
    functionName: 'setAuthorization',
    args: [operator, true],
  });
  const hash = await wallet.sendTransaction({
    account: BORROWER,
    chain: anvil.chain,
    to: core,
    data,
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash });
}

async function createMarketFixture(
  anvil: AnvilFixture,
  write: Write,
  deploy: Deploy,
  core: Address,
  coreAbi: Abi,
  admin: Address,
  guardianSignals: Address,
): Promise<MarketFixture> {
  const tokenArtifact = readArtifact('MockERC20.json');
  const oracleArtifact = readArtifact('MockPriceOracle.json');
  const controllerArtifact = readArtifact('MarketController.json');
  const loanToken = await deploy(tokenArtifact, ['Loan', 'LOAN', 18]);
  const collateralToken = await deploy(tokenArtifact, ['Collateral', 'COLL', 18]);
  const oracle = await deploy(oracleArtifact);
  await write(oracle, oracleArtifact.abi, 'initialize', [10n ** 36n]);
  const marketParams = { loanToken, collateralToken, oracle, irm: zeroAddress, lltv: LLTV };
  const marketArguments = [loanToken, collateralToken, oracle, zeroAddress, LLTV];
  const id = marketIdOf(marketParams);
  const deployed = await deployController(deploy, controllerArtifact, core, id, admin, guardianSignals);
  const controller = deployed.proxy;
  await write(controller, controllerArtifact.abi, 'grantRole', [keccak256(toBytes('MANAGER_ROLE')), admin]);
  const createReceipt = await write(core, coreAbi, 'createMarket', [marketArguments, controller, true]);
  await write(collateralToken, tokenArtifact.abi, 'mint', [admin, 100_000n]);
  await write(collateralToken, tokenArtifact.abi, 'approve', [core, 100_000n]);
  await write(loanToken, tokenArtifact.abi, 'mint', [admin, 100_000n]);
  await write(loanToken, tokenArtifact.abi, 'approve', [core, 100_000n]);
  const borrowerWallet = createWalletClient({ account: BORROWER, chain: anvil.chain, transport: http(anvil.rpcUrl) });
  const writeAsBorrower = contractWriter(anvil, borrowerWallet, BORROWER);

  return {
    id,
    controller,
    controllerImplementation: deployed.implementation,
    controllerAbi: controllerArtifact.abi,
    createReceipt,
    supply: (assets) => write(core, coreAbi, 'supplyCollateral', [marketArguments, assets, BORROWER, '0x']),
    supplyLoan: (assets) => write(core, coreAbi, 'supply', [marketArguments, assets, 0n, admin, '0x']),
    borrow: (assets) => write(core, coreAbi, 'borrow', [marketArguments, assets, 0n, BORROWER, admin]),
    withdraw: (assets) => write(core, coreAbi, 'withdrawCollateral', [marketArguments, assets, BORROWER, admin]),
    liquidate: (seizedAssets) => write(core, coreAbi, 'liquidate', [marketArguments, BORROWER, seizedAssets, 0n, '0x']),
    settle: (borrowShares) => write(core, coreAbi, 'settle', [marketArguments, borrowShares, admin, BORROWER, admin]),
    position: async () => {
      const position = await anvil.publicClient.readContract({
        address: core,
        abi: coreAbi,
        functionName: 'position',
        args: [id, BORROWER],
      });
      return bigintTriple(position, 'position');
    },
    settlementFor: async () => {
      const quote = await anvil.publicClient.readContract({
        address: controller,
        abi: controllerArtifact.abi,
        functionName: 'settlementFor',
        args: [BORROWER, 0n],
      });
      return settlementQuoteOf(quote);
    },
    setActivationConfig: (config) =>
      write(controller, controllerArtifact.abi, 'setCollateralActivationConfig', [activationConfigArguments(config)]),
    setInstantActivation: (caller, enabled) =>
      write(controller, controllerArtifact.abi, 'setInstantActivation', [caller, enabled]),
    setPrice: (price) => write(oracle, oracleArtifact.abi, 'setPrice', [price]),
    setSettlementLtv: (ltv) => writeAsBorrower(controller, controllerArtifact.abi, 'setSettlementLtv', [ltv]),
  };
}

async function deployController(
  deploy: Deploy,
  artifact: ContractArtifact,
  core: Address,
  marketId: Hex,
  admin: Address,
  guardianSignals: Address,
): Promise<{ readonly proxy: Address; readonly implementation: Address }> {
  const implementation = await deploy(artifact, [core]);
  const proxyArtifact = readArtifact('OssifiableProxy.json');
  const initialization = encodeFunctionData({
    abi: artifact.abi,
    functionName: 'initialize',
    args: [marketId, admin, 0n, guardianSignals, activationConfigArguments(DEFAULT_ACTIVATION_CONFIG), [0, 0n, 0n, 0]],
  });
  const proxy = await deploy(proxyArtifact, [implementation, PROXY_ADMIN, initialization]);
  return { proxy, implementation };
}

/** The fixture ABI omits tuple field names, so encode configuration in declared field order. */
function activationConfigArguments(config: ActivationConfig): readonly (number | bigint)[] {
  return [
    config.minActivationDelay,
    config.maxActivationDelay,
    config.maxDelayInflow,
    config.minDepositAmount,
    config.activatingLockDuration,
    config.minActivationAmount,
    config.maxGuardiansQuorumDelay,
    config.delayPerStrike,
    config.delayPerSuspect,
  ];
}

interface MarketParameters {
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltv: bigint;
}

function marketIdOf(parameters: MarketParameters): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, address, address, address, uint256'), [
      parameters.loanToken,
      parameters.collateralToken,
      parameters.oracle,
      parameters.irm,
      parameters.lltv,
    ]),
  );
}

function bigintTriple(value: unknown, field: string): readonly [bigint, bigint, bigint] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${field} is not a three-value tuple`);
  }
  return [bigintOf(value[0], field), bigintOf(value[1], field), bigintOf(value[2], field)];
}

function settlementQuoteOf(
  value: unknown,
): readonly [readonly [bigint, bigint, bigint], readonly [bigint, bigint, bigint]] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('settlement quote is not a two-value tuple');
  }
  return [bigintTriple(value[0], 'personal settlement'), bigintTriple(value[1], 'queue-root settlement')];
}

function bigintOf(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${field} contains a non-bigint value`);
  }
  return value;
}
