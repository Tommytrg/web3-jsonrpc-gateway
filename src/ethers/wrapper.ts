import { BigNumber, ethers, Wallet } from 'ethers'
import { logger, SocketParams } from '../Logger'

interface TransactionParams {
  from: string
  to: string
  gas: string
  gasPrice: string
  value: string
  data: string
  nonce: string
}

/**
 * Wraps the `ether` wallet / signer abstraction so it's compatible with the wallet middleware of
 * `eth-json-rpc-middleware`.
 */
class WalletWrapper {
  defaultGasPrice!: number
  defaultGasLimit!: number
  estimateGasLimit: boolean
  estimateGasPrice: boolean
  forceDefaults: boolean
  gasPriceFactor!: number
  interleaveBlocks: number
  lastKnownBlock: number
  provider: ethers.providers.JsonRpcProvider
  wallets: Wallet[]

  constructor (
    provider: ethers.providers.JsonRpcProvider,
    seed_phrase: string,
    interleave_blocks: number,
    gas_price: number,
    gas_limit: number,
    force_defaults: boolean,
    num_addresses: number,
    estimate_gas_limit: boolean,
    estimate_gas_price: boolean,
    gas_price_factor: number
  ) {
    this.defaultGasPrice = gas_price
    this.defaultGasLimit = gas_limit
    this.forceDefaults = force_defaults
    this.estimateGasLimit = estimate_gas_limit
    this.estimateGasPrice = estimate_gas_price
    this.gasPriceFactor = gas_price_factor
    this.interleaveBlocks = interleave_blocks
    this.lastKnownBlock = 0
    this.provider = provider
    this.wallets = []
    for (let ix = 0; ix < num_addresses; ix ++) {
      this.wallets.push(
        Wallet.fromMnemonic(seed_phrase, `m/44'/60'/0'/0/${ix}`).connect(
          provider
        )
      )
    }
  }

  /**
   * Populate essential transaction parameters, self-estimating gas price and/or gas limit if required.
   * @param socket Socket parms where the RPC call is coming from.
   * @param params Input params, to be validated and completed, if necessary.
   * @returns 
   */
  async composeTransaction (
    socket: SocketParams,
    params: TransactionParams
  ): Promise<ethers.providers.TransactionRequest> {
    
    // Compose actual transaction:
    let tx: ethers.providers.TransactionRequest = {
      from: params.from,
      to: params.to,
      value: params.value,
      data: params.data,
      nonce: params.nonce,
      chainId: this.provider.network.chainId
    }
    if (tx.from) {
      await logger.verbose({ socket, message: `> From:      ${tx.from}` })
    }    
    await logger.verbose({ socket, message: `> To:        ${tx.to || '(deploy)'}` })
    await logger.verbose({ socket,
      message: `> Data:      ${
        tx.data ? tx.data.toString().substring(0, 10) + '...' : '(transfer)'
      }`
    })
    await logger.verbose({ socket, message: `> Value:     ${tx.value || 0} wei` })
    await logger.verbose({ socket, message: `> ChainId:   ${tx.chainId}` })

      tx.gasPrice = (await this.getGasPrice(tx)).toHexString()
    if (tx.gasPrice) {
      await logger.verbose({ socket, message: `> Gas price: ${tx.gasPrice}` })
    }
      tx.gasLimit = (await this.getGasLimit(tx)).toHexString()
    if (tx.gasLimit) {
      await logger.verbose({ socket, message: `> Gas limit: ${tx.gasLimit}` })
    }

    // Return tx object
    return tx
  }

  /**
   * Check for possible rollbacks on the EVM side. 
   * @param socket Socket parms where the RPC call is coming from
   * @returns Last known block number.
   */
  async checkRollbacks(socket: SocketParams): Promise<number> {
    const block = await this.provider.getBlockNumber()
    if (block < this.lastKnownBlock) {
      if (block <= this.lastKnownBlock - this.interleaveBlocks) {
        logger.warn({
          socket,
          message: `Threatening rollback: from epoch ${this.lastKnownBlock} down to ${block}`
        })
      } else {
        logger.warn({
          socket,
          message: `Harmelss rollback: from epoch ${this.lastKnownBlock} down to ${block}`
        })
      }
    }
    this.lastKnownBlock = block
    return block
  }

  /**
   * Gets addresses of all managed wallets.
   */
  async getAccounts (): Promise<string[]> {
    let accounts: string[] = []
    this.wallets.forEach(async (wallet: Wallet) =>
      accounts.push(await wallet.getAddress())
    )
    return accounts
  }

  /**
   * Get block by number. Bypass eventual exceptions.
   */
  async getBlockByNumber (socket: SocketParams, params: string) {
    let res
    try {
      res = await this.provider.getBlock(params)
      if (res) {
        if (res.gasLimit) {
          res = { ...res, gasLimit: res.gasLimit.toHexString() }
        }
        if (res.gasUsed) {
          res = { ...res, gasUsed: res.gasUsed.toHexString() }
        }
        if (res.baseFeePerGas) {
          res = { ...res, baseFeePerGas: res.baseFeePerGas.toHexString() }
        }
        if (res._difficulty) {
          res = { ...res, _difficulty: res._difficulty.toHexString() }
        }
      }
    } catch (e) {
      logger.http({ socket, message: `> Exception bypass: ${e}` })
    }
    return res
  }

  /**
   * Calculates suitable gas price depending on tx params, and gateway settings.
   *
   * @param params Transaction params
   * @returns Estimated gas price, as BigNumber
   */
  async getGasPrice (
    tx: ethers.providers.TransactionRequest
  ): Promise<BigNumber> {
    let gasPrice: BigNumber
    if (this.estimateGasPrice) {
      const providerGasPrice: any = BigNumber.from(
        await this.provider.getGasPrice()
      )
      gasPrice = this.forceDefaults
        ? BigNumber.from(this.defaultGasPrice)
        : BigNumber.from(Math.ceil(providerGasPrice * this.gasPriceFactor))
      const gasPriceThreshold = BigNumber.from(this.defaultGasPrice)
      if (gasPrice.gt(gasPriceThreshold)) {
        let reason = `Estimated gas price exceeds threshold (${gasPrice} > ${gasPriceThreshold})`
        throw {
          reason,
          body: {
            error: {
              code: -32099,
              message: reason
            }
          }
        }
      }
    } else {
      gasPrice = this.forceDefaults
        ? BigNumber.from(this.defaultGasPrice)
        : tx.gasPrice
        ? BigNumber.from(tx.gasPrice)
        : BigNumber.from(this.defaultGasPrice)
    }
    return gasPrice
  }

  /**
   * Calculates suitable gas limit depending on tx params, and gateway settings.
   *
   * @param params Transaction params
   * @returns Estimated gas limit, as BigNumber
   */
  async getGasLimit (
    tx: ethers.providers.TransactionRequest
  ): Promise<BigNumber> {
    let gasLimit: BigNumber
    if (this.estimateGasLimit) {
      try {
        gasLimit = this.forceDefaults
          ? BigNumber.from(this.defaultGasLimit)
          : await this.provider.estimateGas(tx)
      } catch (ex) {
        const reason = `Unpredictable gas limit. Please, check your balance`
        throw {
          reason,
          body: {
            error: {
              code: -32099,
              message: reason
            }
          }
        }
      }
      const gasLimitThreshold: BigNumber = BigNumber.from(this.defaultGasLimit)
      if (gasLimit.gt(gasLimitThreshold)) {
        const reason = `Estimated gas limit exceeds threshold (${gasLimit} > ${gasLimitThreshold})`
        throw {
          reason,
          body: {
            error: {
              code: -32099,
              message: reason
            }
          }
        }
      }
    } else {
      gasLimit = this.forceDefaults
        ? BigNumber.from(this.defaultGasLimit)
        : tx.gasLimit
        ? BigNumber.from(tx.gasLimit)
        : BigNumber.from(this.defaultGasLimit)
    }
    return gasLimit
  }

  /**
   * Get wallet of the given's address, if managed
   */
  async getWalletByAddress (address: string): Promise<Wallet | undefined> {
    let accounts = await this.getAccounts()
    for (let ix = 0; ix < accounts.length; ix++) {
      if (accounts[ix].toLocaleLowerCase() === address.toLowerCase()) {
        return this.wallets[ix]
      }
    }
    return undefined
  }

  /**
   * Gets eth filter changes. Only EthBlockFilters are currently supported.
   */
  async mockEthFilterChanges (socket: SocketParams, id: string): Promise<any> {
    logger.verbose({ socket, message: `> Filter id: ${id}` })
    return [await this.provider.getBlock('latest')]
  }

  /**
   * Surrogates call to provider, after estimating/setting gas, if necessary.
   */
  async processEthCall (
    socket: SocketParams,
    params: TransactionParams
  ): Promise<any> {
    // Check for rollbacks, and get block tag:
    const blockTag = await this.checkRollbacks(socket) - this.interleaveBlocks
    if (this.interleaveBlocks > 0) {
      await logger.verbose({ socket, message: `> Block tag: ${this.lastKnownBlock} --> ${blockTag}` })  
    } else {
      await logger.verbose({ socket, message: `> Block tag: ${this.lastKnownBlock}` })
    }    

    // Compose base transaction:
    let tx: ethers.providers.TransactionRequest = await this.composeTransaction(socket, params)
  
    // Make call:
    return await this.provider.call(tx, blockTag)
  }

  /**
   * Signs a message using the wallet's private key.
   *
   * @remark Return type is made `any` here because the result needs to be a String, not a `Record`.
   */
  async processEthSignMessage (
    address: string,
    message: string,
    socket: SocketParams
  ): Promise<any> {
    logger.verbose({ socket, message: `=> Signing message: ${address} ${message}`})
    let wallet: Wallet | undefined = await this.getWalletByAddress(address)
    if (!wallet) {
      let reason = `No private key available as to sign messages from '${address}'`
      throw {
        reason,
        body: {
          error: {
            code: -32000,
            message: reason
          }
        }
      }
    }
    logger.verbose({ socket, message: `> Signing message "${message}"` })
    return wallet?.signMessage(message)
  }

  /**
   * Signs transaction using wallet's private key, before forwarding to provider.
   *
   * @remark Return type is made `any` here because the result needs to be a String, not a `Record`.
   */
  async processTransaction (
    socket: SocketParams,
    params: TransactionParams
  ): Promise<any> {
    // Check for rollbacks (and just trace a warning message if detected):
    this.checkRollbacks(socket)

    // Compose transaction:
    let tx: ethers.providers.TransactionRequest = await this.composeTransaction(socket, params)

    // Fetch Wallet interaction object:
    let wallet: Wallet | undefined = await this.getWalletByAddress(tx.from || (await this.getAccounts())[0])
    if (!wallet) {
      let reason = `No private key available as to sign messages from '${params.from}'`
      throw {
        reason,
        body: {
          error: {
            code: -32000,
            message: reason
          }
        }
      }
    }

    // Add current nonce:
    if (!tx.nonce) {
      tx.nonce = await wallet?.getTransactionCount()
    }    
    await logger.verbose({ socket, message: `> Nonce:     ${tx.nonce}` })

    // Sign transaction:    
    const signedTx = await wallet?.signTransaction(tx)
    await logger.debug({ socket, message: `=> Signed tx:  ${signedTx}` })

    // Return transaction hash:
    const res = await this.provider.sendTransaction(signedTx)
    await logger.debug({ socket, message: `<= ${res}` })
    return res.hash
  }
}

export { WalletWrapper }
