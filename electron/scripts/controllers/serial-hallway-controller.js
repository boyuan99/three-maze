// serial-hallway-controller.js
// 串行走廊场景的控制器示例

import { SceneController } from '../scene-controller.js'
import { SerialPort } from 'serialport'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

// 串行走廊场景控制器
export class SerialHallwayController extends SceneController {
  constructor(options = {}) {
    super(options)

    // 控制器特定状态
    this.serialPort = null
    this.pythonProcess = null
    this.logFile = null
    this.rewardCount = 0
    this.trialStartTime = null
    this.updateInterval = null
    this.dataLog = []

    // 配置参数
    this.config = {
      serialPortPath: options.serialPortPath || null,
      baudRate: options.baudRate || 115200,
      logEnabled: options.logEnabled !== false, // 默认启用日志
      updateRate: options.updateRate || 100, // 更新频率 (ms)
      pythonModule: options.pythonModule || 'control.serial_handler',
      dataLogLimit: options.dataLogLimit || 1000 // 数据日志限制
    }
  }

  // 设置IPC处理程序
  setupIpc(ipcMain, ipcManager) {
    // 这里注册针对此控制器的特定IPC处理程序

    // 示例：重置位置
    ipcMain.handle('reset-position', (event) => {
      return this.resetPosition()
    })

    // 示例：投递奖励
    ipcMain.handle('deliver-reward', (event) => {
      return this.deliverReward()
    })

    // 示例：获取当前数据日志
    ipcMain.handle('get-data-log', (event) => {
      return this.dataLog
    })
  }

  // 在初始化时执行
  async onInitialize() {
    console.log('SerialHallwayController: Initializing...')

    // 初始化计数器
    this.rewardCount = 0
    this.trialStartTime = Date.now()

    // 创建日志文件
    if (this.config.logEnabled) {
      await this.initializeLogging()
    }

    // 初始化串行通信
    if (this.options.useSerial !== false) {
      await this.initializeSerial()
    }

    // 初始化Python进程（如果需要）
    if (this.options.usePython !== false) {
      await this.initializePython()
    }

    // 设置更新循环
    this.setupUpdateLoop()

    console.log('SerialHallwayController: Initialization complete')
  }

  // 在每一帧更新
  async onUpdate() {
    // 这里执行每帧更新的逻辑，如检查硬件、更新状态等
    // 注意：这个方法会以this.config.updateRate的频率被调用

    // 示例：向场景发送随机数据以模拟传感器
    const mockData = {
      position: {
        x: Math.random() * 10 - 5,
        y: 0,
        z: Math.random() * 10 - 5
      },
      rotation: Math.random() * Math.PI * 2,
      timestamp: Date.now()
    }

    // 将数据发送到前端
    this.sendToScene('serial-data', mockData)

    // 记录数据
    if (this.config.logEnabled) {
      this.logData(mockData)
    }
  }

  // 在销毁时执行
  async onDispose() {
    console.log('SerialHallwayController: Disposing...')

    // 清理更新循环
    if (this.updateInterval) {
      clearInterval(this.updateInterval)
      this.updateInterval = null
    }

    // 关闭串行端口
    if (this.serialPort) {
      this.serialPort.close()
      this.serialPort = null
    }

    // 关闭Python进程
    if (this.pythonProcess) {
      this.pythonProcess.kill()
      this.pythonProcess = null
    }

    // 关闭日志文件
    if (this.logFile) {
      // 写入摘要信息
      fs.appendFileSync(this.logFile, `\n--- SUMMARY ---\n`)
      fs.appendFileSync(this.logFile, `Trial duration: ${(Date.now() - this.trialStartTime) / 1000} seconds\n`)
      fs.appendFileSync(this.logFile, `Total rewards: ${this.rewardCount}\n`)
      fs.appendFileSync(this.logFile, `--- END OF LOG ---\n`)
    }

    console.log('SerialHallwayController: Disposed')
    console.log(`Total rewards earned: ${this.rewardCount}`)
  }

  // 初始化日志
  async initializeLogging() {
    try {
      const logDir = path.join(app.getPath('userData'), 'logs')

      // 确保日志目录存在
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
      }

      const timestamp = new Date().toISOString().replace(/:/g, '-')
      this.logFile = path.join(logDir, `serial_hallway_${timestamp}.log`)

      // 写入日志头部
      fs.writeFileSync(this.logFile, `--- SERIAL HALLWAY SESSION LOG ---\n`)
      fs.appendFileSync(this.logFile, `Start time: ${new Date().toISOString()}\n`)
      fs.appendFileSync(this.logFile, `Configuration: ${JSON.stringify(this.config)}\n`)
      fs.appendFileSync(this.logFile, `\n--- DATA LOG ---\n`)

      console.log(`Logging to: ${this.logFile}`)
      return true
    } catch (error) {
      console.error('Failed to initialize logging:', error)
      return false
    }
  }

  // 记录数据
  logData(data) {
    // 添加到内存中的数据日志
    this.dataLog.push(data)
    if (this.dataLog.length > this.config.dataLogLimit) {
      this.dataLog.shift() // 保持日志大小不超过限制
    }

    // 写入文件
    if (this.logFile) {
      fs.appendFileSync(this.logFile, `${JSON.stringify(data)}\n`)
    }
  }

  // 初始化串行通信
  async initializeSerial() {
    try {
      // 如果未指定端口路径，则获取可用端口列表
      if (!this.config.serialPortPath) {
        const ports = await SerialPort.list()

        if (ports.length === 0) {
          console.warn('No serial ports available')
          return false
        }

        // 在实际应用中，可能需要更智能地选择正确的端口
        this.config.serialPortPath = ports[0].path
      }

      // 创建串行端口实例
      this.serialPort = new SerialPort({
        path: this.config.serialPortPath,
        baudRate: this.config.baudRate
      })

      // 设置事件处理程序
      this.serialPort.on('data', (data) => {
        // 处理接收到的数据
        const dataStr = data.toString().trim()
        console.log(`Serial data received: ${dataStr}`)

        // 解析数据（根据您的协议格式）
        try {
          // 这里假设数据是JSON格式
          const parsedData = JSON.parse(dataStr)

          // 将解析后的数据发送到前端
          this.sendToScene('serial-data', parsedData)

          // 记录数据
          if (this.config.logEnabled) {
            this.logData(parsedData)
          }
        } catch (error) {
          // 如果不是JSON，则发送原始数据
          this.sendToScene('serial-raw-data', dataStr)
        }
      })

      this.serialPort.on('error', (error) => {
        console.error('Serial port error:', error)
        this.sendToScene('serial-error', error.message)
      })

      console.log(`Serial port opened: ${this.config.serialPortPath}`)
      return true
    } catch (error) {
      console.error('Failed to initialize serial:', error)
      this.sendToScene('serial-error', error.message)
      return false
    }
  }

  // 初始化Python进程
  async initializePython() {
    try {
      const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3'

      this.pythonProcess = spawn(pythonExecutable, ['-m', this.config.pythonModule], {
        stdio: ['pipe', 'pipe', 'pipe']
      })

      console.log(`Started Python process: ${this.config.pythonModule}`)

      // 处理标准输出
      this.pythonProcess.stdout.on('data', (data) => {
        const dataStr = data.toString()
        console.log(`Python stdout: ${dataStr}`)

        // 如果数据格式是JSON，则解析并发送到前端
        try {
          const parsedData = JSON.parse(dataStr)
          this.sendToScene('python-data', parsedData)
        } catch (error) {
          // 如果不是JSON，则发送原始数据
          this.sendToScene('python-output', dataStr)
        }
      })

      // 处理标准错误
      this.pythonProcess.stderr.on('data', (data) => {
        const dataStr = data.toString()
        console.error(`Python stderr: ${dataStr}`)
        this.sendToScene('python-error', dataStr)
      })

      // 处理进程退出
      this.pythonProcess.on('close', (code) => {
        console.log(`Python process exited with code ${code}`)
        this.pythonProcess = null

        if (code !== 0) {
          this.sendToScene('python-exit', {
            code,
            error: `Python process exited with code ${code}`
          })
        }
      })

      return true
    } catch (error) {
      console.error('Failed to initialize Python:', error)
      this.sendToScene('python-error', error.message)
      return false
    }
  }

  // 设置更新循环
  setupUpdateLoop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval)
    }

    this.updateInterval = setInterval(() => {
      this.update()
    }, this.config.updateRate)

    console.log(`Update loop started with rate: ${this.config.updateRate}ms`)
  }

  // 重置位置（示例方法）
  resetPosition() {
    console.log('Resetting position')

    // 向串行端口发送重置命令（根据您的协议）
    if (this.serialPort && this.serialPort.isOpen) {
      this.serialPort.write('RESET_POSITION\n')
    }

    // 通知前端
    this.sendToScene('position-reset', { timestamp: Date.now() })

    return { success: true }
  }

  // 投递奖励（示例方法）
  deliverReward() {
    console.log('Delivering reward')

    // 向串行端口发送奖励命令（根据您的协议）
    if (this.serialPort && this.serialPort.isOpen) {
      this.serialPort.write('DELIVER_REWARD\n')
    }

    // 更新奖励计数
    this.rewardCount++

    // 记录奖励事件
    if (this.config.logEnabled) {
      this.logData({
        type: 'reward',
        count: this.rewardCount,
        timestamp: Date.now()
      })
    }

    // 通知前端
    this.sendToScene('reward-delivered', {
      count: this.rewardCount,
      timestamp: Date.now()
    })

    return { success: true, count: this.rewardCount }
  }
} 