import { Service } from 'typedi'
import { exec } from 'child_process'
import config from '../../config'
import redis from 'redis'
import ps from 'ps-node'
import uuidv4 from 'uuid/v4'
import { createHtml, IHTMLParams } from '../utils/create_pdf'
import {
  IReportItemResponse,
  IGetReportItem,
  IGetReportDetailItem } from '../../interfaces/reports'
import {
  IApplication,
  IApplicationItem,
  IApplicationSummary } from '../../interfaces/admin_manage'
import { ICategoryResponse } from '../../interfaces/category'
import {
  ReportsModel,
  AdminManageModel,
  CategoryModel } from '../database/models'
import { Context } from 'koa'
const { REDIS_HOST, REDIS_PORT } = config

@Service()
export default class AppService {

  constructor () {
    this.redisConn = redis.createClient({
      host: REDIS_HOST,
      port: REDIS_PORT
    })
  }

  private redisConn

  private redisSetKey (key: string, value: any) {
    this.redisConn.set(key, value)
    this.redisConn.expire(key, 60 * 60 * 24)
  }

  private async redisGetValueFromKey (key: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.redisConn.get(key, (err, reply) => {
        if (err) reject(err)
        else {
          if (reply) resolve(reply)
          else reject('Expired')
        }
      })
    })
  }

  /**
   * exec a command with Promise
   * @param {string} command
   * @private
   * @async
   * @return {Promise<string>}
   */
  private async execAsync (command: string, uuid: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child = exec(command, (err, stdout, stderror) => {
        if (err) reject(err.message)
        else resolve(stdout)
      })
      this.redisSetKey(uuid, child.pid)
      setTimeout(() => {
        child.kill('SIGINT')
        reject('Timed out')
      }, 1000 * 60 * 60 * 24)
    })
  }

  /**
   * find results by page
   * @param {any} model
   * @param {any} condition
   * @param {number} limit
   * @param {number} page
   * @private
   * @async
   * @return {Promise<{ item: any[], next: boolean }>}
   */
  private async pagination (
    model: any,
    condition: any,
    limit: number,
    page: number): Promise<{ items: any[], next: boolean }> {
    let results = await model.find(condition)
      .skip(limit * (page - 1))
      .limit(limit)
    let nextResults = await model.find(condition)
      .skip(limit * page)
      .limit(limit)
    return {
      items: results,
      next: nextResults.length !== 0
    }
  }

  /**
   * kill a process with a specified pid
   * @param {string} uuid
   * @public
   * @async
   * @return {Promise<string>}
   */
  public async killCurrentProcess (uuid: string): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {
      try {
        let pid = await this.redisGetValueFromKey(uuid)
        ps.kill(pid, err => {
          if (err) reject(err)
          else resolve(`Killed process with pid ${pid}`)
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  /**
   * run application and get results
   * @param {string} application
   * @param {string} ip
   * @param {string} command
   * @public
   * @async
   * @return {Promise<IReportItemResponse>}
   */
  public async runApplication (
    application: string,
    ip: string,
    command: string,
    uuid: string): Promise<IReportItemResponse> {
    let findApplication =
      await AdminManageModel.findById(application)
    let bin = findApplication.binaryPath
    let fullCommand = `${bin} ${command}`
    let start_time: string = Date.parse(new Date().toString()).toString()
    let responseBasic = {
      start_time,
      command: fullCommand,
      client_ip: ip,
      application }
    try {
      let execResult = await this.execAsync(fullCommand, uuid)
      let response: IReportItemResponse = {
        ...responseBasic,
        end_time: Date.parse(new Date().toString()).toString(),
        succeeded: true,
        result: execResult
      }
      let report = await ReportsModel.insertMany(<any[]>[{
        ...response, views: 0, downloads: 0 }])
      return { id: report[0]._id,  ...response }
    } catch (e) {
      let response: IReportItemResponse = {
        ...responseBasic,
        end_time: Date.parse(new Date().toString()).toString(),
        succeeded: false,
        result: e.toString()
      }
      await ReportsModel.insertMany(<any[]>[{
        ...response, views: 0, downloads: 0 }])
      return response
    }
  }

  /**
   * return information of the specific application
   * @param {string} id
   * @public
   * @async
   * @return {Promise<IApplication>}
   */
  public async getApplicationInformation (
    id: string): Promise<IApplicationItem> {
    try {
      let result = await AdminManageModel.findById(id)
      let { _id, binaryPath, category, brief, name, avatar, version, updated } = result
      return {
        id: _id,
        binaryPath, updated, version, avatar, name, brief, category
      }
    } catch (e) {
      throw new Error(e)
    }
  }

  /**
   * get all application lists
   * @param {number} limit
   * @param {number} page
   * @param {string} category
   * @public
   * @async
   * @return {{next: boolean, applications: IApplicationSummary[]}}
   */
  public async getAllApplications (
    limit: number,
    page: number,
    category?: string): Promise<{ next: boolean, items: IApplicationSummary[] }> {
    let query = category ? { category } : {}
    try {
      if (limit === -1) {
        let result = await AdminManageModel.find(query)
        return {
          next: false,
          items: result.map((value, index) => {
            let { _id, binaryPath, name, avatar, version, updated, category, brief } = value
            return {
              id: _id, binaryPath, updated, version, avatar, name, category, brief }
          })
        }
      } else {
        let result = await this.pagination(AdminManageModel, query, limit, page)
        return {
          next: result.next,
          items: result.items.map((value, index) => {
            let { _id, binaryPath, name, avatar, version, updated, category, brief } = value
            return {
              id: _id, binaryPath, updated, version, avatar, name, category, brief }
          })
        }
      }
    } catch (e) {
      throw new Error(e)
    }
  }

  /**
   * get all categories
   * @param {number} limit
   * @param {number} page
   * @public
   * @async
   * @return { Promise<{next: boolean, categories: ICategoryResponse[]}>}
   */
  public async getAllCategories (
    limit: number,
    page: number): Promise<{next: boolean, items: ICategoryResponse[]}> {
    try {
      if (limit === -1) {
        let result = await CategoryModel.find({})
        return {
          next: false,
          items: result.map((value, index) => {
            return {
              id: value._id,
              name: value.name
            }
          })
        }
      } else {
        let result = await this.pagination(CategoryModel, {}, limit, page)
        return {
          next: result.next,
          items: result.items.map((value, index) => {
            return {
              id: value._id,
              name: value.name
            }
          })
        }
      }
    } catch (e) {
      throw new Error(e)
    }
  }

  /**
   *
   * @param {number} limit
   * @param {number} page
   * @param {string} application
   * @public
   * @async
   * @return {Promise<{next: boolean, items: IGetReportItem[]}>}
   */
  public async getAllReports (
    limit: number,
    page: number,
    application?: string): Promise<{next: boolean, items: IGetReportItem[]}> {
    try {
      let condition = application ? { application } : {}
      let result = await this.pagination(ReportsModel, condition, limit, page)
      let items = []
      for (let item of result.items) {
        let {
          _id, succeeded, start_time, end_time, views, downloads, application, command } = item
        let appInformation = await this.getApplicationInformation(application)
        items.push({
          id: _id, succeeded, end_time, start_time, views, downloads,
          application_name: appInformation.name,
          application_id: application,
          command })
      }
      return {
        next: result.next,
        items
      }
    } catch (e) {
      throw new Error(e)
    }
  }

  /**
   * get report information
   * @param {string} id
   * @public
   * @async
   * @return {Promise<IGetReportDetailItem>}
   */
  public async getReportInformation (
    id: string): Promise<IGetReportDetailItem> {
    try {
      let results = await ReportsModel.findById(id)
      let { start_time, end_time, succeeded, views,
        downloads, result, application, command } = results
      let currentViews = views + 1
      let appInformation = await this.getApplicationInformation(application)
      await ReportsModel.findByIdAndUpdate(id, { views: currentViews })
      return {
        application_name: appInformation.name,
        application_id: application,
        result, downloads, views: currentViews, succeeded, end_time, start_time, command
      }
    } catch (e) {
      throw new Error(e)
    }
  }

  /**
   * generate pdf document
   * @param {Context} context
   * @param {string} id
   * @public
   * @async
   * @return {Promise<Buffer>}
   */
  public async downloadReport (context: Context, id: string): Promise<Buffer> {
    let report = await ReportsModel.findById(id)
    let {
      application,
      start_time,
      command,
      succeeded, result } = report
    let { name, version } = await AdminManageModel.findById(application)
    let params: IHTMLParams = {
      app_name: name,
      report_id: id,
      app_id: application,
      app_version: version,
      start_time,
      download_time: Date.parse(new Date().toString()).toString(),
      command,
      ok: succeeded,
      result
    }
    let buffer = await createHtml(params)
    let filename = `report_${id}_${uuidv4()}.pdf`
    context.set('Content-Type', 'application/pdf')
    context.set('Content-Disposition', `attachment; filename="${filename}"`)
    await ReportsModel.findByIdAndUpdate(id, { downloads: report.downloads + 1 })
    return buffer
  }

}
