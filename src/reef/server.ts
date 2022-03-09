import express, { Express } from 'express'
import cors from 'cors'

import { ethers } from 'ethers'
import { logger, SocketParams, traceKeyValue } from '../Logger'
import { WalletWrapper } from './wrapper'

/**
 * Leverages `JsonRpcEngine` to intercept account-related calls, and pass any other calls down to a destination
 * provider, e.g. Infura.
 */
export class WalletMiddlewareServer {
  expressServer: Express
  totalRequests: number
  wrapper: WalletWrapper

  dictionaryEthCfx: { [K: string]: string } = {
  }

  rpcMethodHandlers: { [K: string]: any }
  rpcParamsHandlers: { [K: string]: any }

  constructor (
    rpcUrl: string,
    graphUrl: string,
    seedPhrase: string
  ) {
    this.expressServer = express()
    this.totalRequests = 0
    this.wrapper = new WalletWrapper(
      rpcUrl,
      graphUrl,
      seedPhrase
    )

    this.rpcParamsHandlers = {
    }

    this.rpcMethodHandlers = {
      net_version: this.wrapper.version,
      eth_accounts: this.wrapper.getAccounts,
      eth_blockNumber: this.wrapper.getBlockNumber,
      eth_call: this.wrapper.call,
      eth_estimateGas: this.wrapper.estimateGas,
      eth_gasPrice: this.wrapper.estimateGasPrice,
      eth_getBalance: this.wrapper.getBalance,
      eth_getBlockByNumber: this.wrapper.getBlockByNumber,
      eth_getCode: this.wrapper.getCode,
      eth_getTransactionByHash: this.wrapper.getTransactionByHash,
      eth_getTransactionReceipt: this.wrapper.getTransactionReceipt,
      eth_newBlockFilter: this.wrapper.createEthBlockFilter,
      eth_sendTransaction: this.wrapper.sendTransaction
    }

    return this
  }

  /**
   * Initializes the Express server, configures CORS, and passes requests back and forth between the Express server and
   * the `JsonRpcEngine`.
   */
  initialize () {
    this.expressServer.use(cors())
    this.expressServer.use(express.json())

    this.expressServer.post(
      '*',
      async (req: express.Request, res: express.Response) => {
        const request = req.body

        const socket: SocketParams = {
          clientAddr: req.connection.remoteAddress || 'unknownAddr',
          clientPort: req.connection.remotePort || 0,
          clientId: request.id,
          serverId: ++ this.totalRequests
        }
        let method = request.method

        // Translate incoming method, if necessary
        if (method in this.dictionaryEthCfx) {
          request.method = this.dictionaryEthCfx[request.method]
          logger.log({
            level: 'info',
            socket,
            message: `>> ${method} >> ${request.method}`
          })
        } else {
          logger.log({ level: 'info', socket, message: `>> ${method}` })
        }
        // Debug trace params, if any
        if (request.params && request.params.length > 0) {
          logger.log({
            level: 'debug',
            socket,
            message: `> ${JSON.stringify(request.params)}`
          })
        }

        const header = {
          jsonrpc: request.jsonrpc,
          id: request.id
        }

        let response: {
          id: number
          jsonrpc: string
          result?: string
          error?: string
        }
        let result

        try {
          // Pre-process params, if necessary:
          if (method in this.rpcParamsHandlers) {
            request.params = await this.rpcParamsHandlers[method].bind(this)(
              socket,
              ...(request.params || [])
            )
          }
          // Intercept method call, if required:
          if (request.method in this.rpcMethodHandlers) {
            result = await this.rpcMethodHandlers[request.method].bind(this.wrapper)(
              socket,
              ...(request.params || [])
            )
          } else {
            const reason = `Unsupported ${request.method}` 
            throw {
              reason,
              body: {
                code: -32699,
                message: reason
              }
            }
          } 
          response = { ...header, result }
        } catch (exception: any) {
          console.log("exception ====>", exception)
          if (!exception.code) {
            // if no error code is specified,
            //   assume the Conflux provider is actually reporting an execution error:
            exception = {
              reason: exception.toString(),
              body: {
                error: {
                  code: -32015,
                  message: exception.toString(),
                  data: exception
                }
              }
            }
          }
          const message =
            exception.reason ||
            (exception.error && exception.error.reason) ||
            exception ||
            'null exception'
          let body =
            exception.body ||
            (exception.error && exception.error.body
              ? exception.error.body
              : {
                  error: {
                    code: exception.code || -32099,
                    message: `"${message}"`,
                    data: exception.data
                  }
                })
          body = typeof body !== 'string' ? JSON.stringify(body) : body
          try {
            response = { ...header, error: JSON.parse(body).error }
          } catch (e) {
            logger.log({
              level: 'error',
              socket,
              message: `<= Invalid JSON response: "${body}"`
            })
            response = {
              ...header,
              error: `{ "code": -32700, "message": "Invalid JSON response" }`
            }
          }
        }
        if (response.error) {
          logger.log({
            level: 'warn',
            socket,
            message: `<= Error: ${JSON.stringify(response.error)}`
          })
        } else {
          if (
            method.startsWith('eth_') &&
            result &&
            typeof result === 'object'
          ) {
            // TODO
            // result = this.translateCfxResponseObject(result, socket)
          }
          logger.log({
            level: 'http',
            socket,
            message: `<< ${JSON.stringify(result)}`
          })
        }
        res.status(200).json(response)
      }
    )
    return this
  }

  /**
   * Tells the Express server to start listening.
   */
  async listen (port: number, hostname?: string) {
    await this.wrapper.setup()

    traceKeyValue('Reef provider', [
      ['Chain name', await this.wrapper.provider.api.rpc.system.chain()],
      ['Node name', await this.wrapper.provider.api.rpc.system.name()],
      ['Node version', await this.wrapper.provider.api.rpc.system.version()],
    ])

    traceKeyValue('Reef wallet', [
      ['Address   ', await this.wrapper.signer.getAddress()],
      ['Balance   ', `${ethers.utils.formatEther(await this.wrapper.signer.getBalance())} REEF`],
      ['Nonce     ', await this.wrapper.signer.getTransactionCount()]
    ])

    console.log(
      `Listening on ${hostname ||
        '0.0.0.0'}:${port} [${logger.level.toUpperCase()}]`
    )
    console.log()

    this.expressServer.listen(port, hostname || '0.0.0.0')

    return this
  }

  /**
   * Verbosely log incoming parameters.
   */
  traceParams (params: any[], socket: SocketParams) {
    params.forEach((value, index) => {
      logger.verbose({
        socket,
        message: `> [${index}] => ${JSON.stringify(value)}`
      })
    })
    return params
  }

  /**
   * Lambda function to perform actual translation of Eth addresses to Conflux alphanumeric format.
   * See: https://github.com/Conflux-Chain/CIPs/blob/master/CIPs/cip-37.md
   */
  translateEthAddress (_address: string) {
  }
}