import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { spawn } from 'child_process'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const getPythonConfig = () => {
  const platform = process.platform
  const venvPath = join(__dirname, '../.venv')
  
  switch (platform) {
    case 'win32':
      return {
        interpreter: join(venvPath, 'Scripts', 'python.exe'),
        pip: join(venvPath, 'Scripts', 'pip.exe'),
        venvCommand: ['python', '-m', 'venv'],
        requirements: ['pyserial', 'numpy', 'nidaqmx']
      }
    case 'darwin':
      return {
        interpreter: join(venvPath, 'bin', 'python3'),
        pip: join(venvPath, 'bin', 'pip3'),
        venvCommand: ['python3', '-m', 'venv'],
        requirements: ['pyserial', 'numpy', 'nidaqmx']
      }
    case 'linux':
      return {
        interpreter: join(venvPath, 'bin', 'python3'),
        pip: join(venvPath, 'bin', 'pip3'),
        venvCommand: ['python3', '-m', 'venv'],
        requirements: ['pyserial', 'numpy', 'nidaqmx']
      }
    default:
      throw new Error(`Unsupported platform: ${platform}`)
  }
}

const setupPython = async () => {
  const config = getPythonConfig()
  const venvPath = join(__dirname, '../.venv')

  // Create virtual environment if it doesn't exist
  if (!fs.existsSync(venvPath)) {
    console.log('Creating Python virtual environment...')
    await new Promise((resolve, reject) => {
      const [cmd, ...args] = [...config.venvCommand, venvPath]
      const process = spawn(cmd, args)
      
      process.stdout.on('data', (data) => console.log(data.toString()))
      process.stderr.on('data', (data) => console.error(data.toString()))
      process.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Failed to create venv, exit code: ${code}`))
      })
    })
  }

  // Upgrade pip first
  console.log('Upgrading pip...')
  await new Promise((resolve, reject) => {
    const upgradePip = spawn(config.interpreter, [
      '-m',
      'pip',
      'install',
      '--upgrade',
      'pip'
    ])
    
    upgradePip.stdout.on('data', (data) => console.log(data.toString()))
    upgradePip.stderr.on('data', (data) => console.error(data.toString()))
    upgradePip.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Failed to upgrade pip, exit code: ${code}`))
    })
  })

  // Install requirements
  console.log('Installing Python requirements...')
  await new Promise((resolve, reject) => {
    const install = spawn(config.interpreter, [
      '-m',
      'pip',
      'install',
      'pyserial',
      'numpy',
      'nidaqmx'
    ])
    
    install.stdout.on('data', (data) => console.log(data.toString()))
    install.stderr.on('data', (data) => console.error(data.toString()))
    install.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Failed to install requirements, exit code: ${code}`))
    })
  })
}

setupPython().catch(console.error) 