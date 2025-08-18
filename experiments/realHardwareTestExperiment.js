/**
 * Real Hardware Test Experiment
 * 
 * This experiment validates the modular architecture with actual hardware:
 * - Tests real serial communication (COM ports)
 * - Validates resource management and conflict prevention
 * - Performance testing with real data streams
 * - Memory leak detection during continuous operation
 */

import { BaseExperiment } from '../src/experiments/BaseExperiment.js';

export default class RealHardwareTestExperiment extends BaseExperiment {
  constructor(userConfig = {}) {
    super({
      name: 'Real Hardware Test Experiment',
      version: '1.0.0',
      
      // USER-CONFIGURABLE: Serial settings for real hardware testing
      serial: {
        port: userConfig.serialPort || 'COM3',                    // Real COM port
        baudRate: userConfig.serialBaudRate || 115200,           // Real baud rate
        initialization: userConfig.serialInit || '10000,50,10,1\n', // Real init command
        timeout: userConfig.timeout || 5000,                     // Connection timeout
        retryAttempts: userConfig.retryAttempts || 3              // Retry on failure
      },
      
      // USER-CONFIGURABLE: Performance monitoring settings
      performance: {
        dataPointsToTrack: userConfig.dataPoints || 1000,        // Track last N data points
        performanceInterval: userConfig.perfInterval || 5000,    // Log performance every 5s
        memoryCheckInterval: userConfig.memoryInterval || 10000, // Check memory every 10s
        maxMemoryMB: userConfig.maxMemory || 100                 // Alert if over 100MB
      },
      
      // USER-CONFIGURABLE: Data logging for real testing
      logging: {
        path: userConfig.logPath || './test-data',               // Test data directory
        format: userConfig.logFormat || 'csv',                  // CSV for analysis
        filename: userConfig.logFilename || `hardware-test-${Date.now()}.csv`,
        realTimeLogging: userConfig.realTimeLogging || true     // Log immediately
      },
      
      // USER-CONFIGURABLE: Test parameters
      testParams: {
        testDuration: userConfig.testDuration || 60000,         // 1 minute test
        expectedDataRate: userConfig.expectedRate || 10,        // Expected data per second
        maxDataGaps: userConfig.maxGaps || 5,                   // Max allowed data gaps
        validateDataIntegrity: userConfig.validateData || true  // Check data consistency
      },
      
      // USER-CONFIGURABLE: IPC handler names for this test
      ipcNames: {
        startTest: userConfig.startTestHandler || 'real-hardware-start-test',
        stopTest: userConfig.stopTestHandler || 'real-hardware-stop-test',
        getTestStatus: userConfig.getStatusHandler || 'real-hardware-get-status',
        getPerformanceMetrics: userConfig.getPerfHandler || 'real-hardware-get-performance',
        resetTest: userConfig.resetHandler || 'real-hardware-reset-test'
      },
      
      ...userConfig
    });
    
    // Test state tracking
    this.testStartTime = null;
    this.testActive = false;
    this.dataReceived = [];
    this.performanceMetrics = {
      totalDataPoints: 0,
      averageDataRate: 0,
      dataGaps: 0,
      memoryUsage: 0,
      cpuUsage: 0,
      errors: []
    };
    this.performanceTimer = null;
    this.memoryTimer = null;
    this.serialHandle = null;
    this.logHandle = null;
  }

  /**
   * Initialize the hardware test experiment
   */
  async onInitialize() {
    console.log(`Starting ${this.name} v${this.version}`);
    console.log('Hardware Test Configuration:', {
      serialPort: this.config.serial.port,
      baudRate: this.config.serial.baudRate,
      testDuration: this.config.testParams.testDuration,
      expectedDataRate: this.config.testParams.expectedDataRate
    });
    
    try {
      // Initialize data logging first
      await this.initializeLogging();
      
      // Start performance monitoring
      this.startPerformanceMonitoring();
      
      console.log('Hardware test experiment initialized successfully');
      console.log('Ready to test real hardware communication');
      
    } catch (error) {
      console.error('Hardware test initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize data logging for test results
   */
  async initializeLogging() {
    try {
      const logConfig = {
        format: this.config.logging.format,
        path: this.config.logging.path,
        filename: this.config.logging.filename,
        headers: ['timestamp', 'data_point', 'x', 'y', 'theta', 'processing_time', 'memory_mb', 'gap_detected']
      };
      
      this.logHandle = await this.requestHardware('data-logging', logConfig);
      console.log('Test data logging initialized');
      
    } catch (error) {
      console.error('Failed to initialize test logging:', error);
      throw error;
    }
  }

  /**
   * Start the real hardware test
   */
  async startHardwareTest() {
    if (this.testActive) {
      throw new Error('Hardware test already running');
    }
    
    try {
      console.log('Starting real hardware test...');
      
      // Initialize serial communication with real hardware
      const serialConfig = {
        port: this.config.serial.port,
        baudRate: this.config.serial.baudRate,
        initialization: this.config.serial.initialization,
        timeout: this.config.serial.timeout,
        dataHandler: this.onRealSerialData.bind(this)
      };
      
      this.serialHandle = await this.requestHardware('serial-port', serialConfig);
      
      // Reset test state
      this.testStartTime = Date.now();
      this.testActive = true;
      this.dataReceived = [];
      this.performanceMetrics = {
        totalDataPoints: 0,
        averageDataRate: 0,
        dataGaps: 0,
        memoryUsage: 0,
        cpuUsage: 0,
        errors: []
      };
      
      // Set test timeout
      setTimeout(() => {
        if (this.testActive) {
          this.stopHardwareTest('timeout');
        }
      }, this.config.testParams.testDuration);
      
      console.log(`Hardware test started - will run for ${this.config.testParams.testDuration}ms`);
      console.log(`Expected data rate: ${this.config.testParams.expectedDataRate} points/second`);
      
      return { success: true, message: 'Hardware test started successfully' };
      
    } catch (error) {
      this.testActive = false;
      console.error('Failed to start hardware test:', error);
      throw error;
    }
  }

  /**
   * Handle real serial data from hardware
   */
  onRealSerialData(serialData) {
    if (!this.testActive) return;
    
    const processingStartTime = Date.now();
    
    try {
      // Track data point
      const dataPoint = {
        timestamp: processingStartTime,
        data: serialData,
        processingTime: 0
      };
      
      // Check for data gaps (time since last data point)
      if (this.dataReceived.length > 0) {
        const lastDataTime = this.dataReceived[this.dataReceived.length - 1].timestamp;
        const timeSinceLastData = processingStartTime - lastDataTime;
        const expectedInterval = 1000 / this.config.testParams.expectedDataRate;
        
        if (timeSinceLastData > expectedInterval * 2) { // More than 2x expected interval
          this.performanceMetrics.dataGaps++;
          dataPoint.gapDetected = true;
          console.warn(`Data gap detected: ${timeSinceLastData}ms since last data`);
        }
      }
      
      // Validate data integrity if enabled
      if (this.config.testParams.validateDataIntegrity) {
        this.validateDataIntegrity(serialData);
      }
      
      // Store data point (keep only recent points to prevent memory issues)
      this.dataReceived.push(dataPoint);
      if (this.dataReceived.length > this.config.performance.dataPointsToTrack) {
        this.dataReceived.shift(); // Remove oldest
      }
      
      // Update performance metrics
      this.performanceMetrics.totalDataPoints++;
      const testDuration = processingStartTime - this.testStartTime;
      this.performanceMetrics.averageDataRate = this.performanceMetrics.totalDataPoints / (testDuration / 1000);
      
      // Calculate processing time
      const processingEndTime = Date.now();
      dataPoint.processingTime = processingEndTime - processingStartTime;
      
      // Log data point if real-time logging enabled
      if (this.config.logging.realTimeLogging && this.logHandle) {
        this.logDataPoint(dataPoint, serialData);
      }
      
      // Check for performance issues
      if (dataPoint.processingTime > 50) { // Over 50ms processing time
        console.warn(`Slow data processing detected: ${dataPoint.processingTime}ms`);
      }
      
    } catch (error) {
      this.performanceMetrics.errors.push({
        timestamp: Date.now(),
        error: error.message,
        type: 'data_processing'
      });
      console.error('Error processing real serial data:', error);
    }
  }

  /**
   * Validate data integrity
   */
  validateDataIntegrity(serialData) {
    // Check for expected 13-value CSV format
    if (typeof serialData === 'object' && serialData.x !== undefined) {
      // Check for reasonable position values
      if (Math.abs(serialData.x) > 1000 || Math.abs(serialData.y) > 1000) {
        throw new Error(`Unreasonable position values: x=${serialData.x}, y=${serialData.y}`);
      }
      
      // Check for NaN values
      if (isNaN(serialData.x) || isNaN(serialData.y) || isNaN(serialData.theta)) {
        throw new Error('NaN values detected in serial data');
      }
    }
  }

  /**
   * Log data point for analysis
   */
  async logDataPoint(dataPoint, serialData) {
    try {
      const logEntry = [
        dataPoint.timestamp,
        this.performanceMetrics.totalDataPoints,
        serialData.x || 0,
        serialData.y || 0, 
        serialData.theta || 0,
        dataPoint.processingTime,
        this.performanceMetrics.memoryUsage,
        dataPoint.gapDetected || false
      ].join(',');
      
      await this.logData(this.logHandle, logEntry + '\n');
      
    } catch (error) {
      console.error('Failed to log data point:', error);
    }
  }

  /**
   * Stop the hardware test
   */
  async stopHardwareTest(reason = 'manual') {
    if (!this.testActive) {
      return { success: false, message: 'No test running' };
    }
    
    try {
      this.testActive = false;
      const testDuration = Date.now() - this.testStartTime;
      
      console.log(`Hardware test stopped (${reason}) after ${testDuration}ms`);
      console.log(`Total data points received: ${this.performanceMetrics.totalDataPoints}`);
      console.log(`Average data rate: ${this.performanceMetrics.averageDataRate.toFixed(2)} points/second`);
      console.log(`Data gaps detected: ${this.performanceMetrics.dataGaps}`);
      
      // Release hardware resources
      if (this.serialHandle) {
        await this.releaseHardware(this.serialHandle);
        this.serialHandle = null;
      }
      
      // Generate test report
      const testReport = this.generateTestReport(testDuration, reason);
      
      // Log final test results
      if (this.logHandle) {
        await this.logData(this.logHandle, `\n# Test Summary:\n# ${JSON.stringify(testReport)}\n`);
      }
      
      return { success: true, report: testReport };
      
    } catch (error) {
      console.error('Error stopping hardware test:', error);
      throw error;
    }
  }

  /**
   * Generate comprehensive test report
   */
  generateTestReport(testDuration, stopReason) {
    const expectedDataPoints = (testDuration / 1000) * this.config.testParams.expectedDataRate;
    const dataReceivalRate = (this.performanceMetrics.totalDataPoints / expectedDataPoints) * 100;
    
    return {
      testDuration: testDuration,
      stopReason: stopReason,
      dataPoints: {
        received: this.performanceMetrics.totalDataPoints,
        expected: Math.floor(expectedDataPoints),
        receivalRate: `${dataReceivalRate.toFixed(1)}%`
      },
      performance: {
        averageDataRate: this.performanceMetrics.averageDataRate,
        dataGaps: this.performanceMetrics.dataGaps,
        maxMemoryUsage: this.performanceMetrics.memoryUsage,
        errors: this.performanceMetrics.errors.length
      },
      testResult: this.evaluateTestResult(dataReceivalRate),
      recommendations: this.generateRecommendations(dataReceivalRate)
    };
  }

  /**
   * Evaluate overall test result
   */
  evaluateTestResult(dataReceivalRate) {
    if (dataReceivalRate >= 95 && this.performanceMetrics.errors.length === 0) {
      return 'EXCELLENT - Hardware communication performing optimally';
    } else if (dataReceivalRate >= 85 && this.performanceMetrics.errors.length <= 2) {
      return 'GOOD - Minor performance issues detected';
    } else if (dataReceivalRate >= 70) {
      return 'FAIR - Noticeable performance issues, investigation recommended';
    } else {
      return 'POOR - Significant hardware communication problems detected';
    }
  }

  /**
   * Generate recommendations based on test results
   */
  generateRecommendations(dataReceivalRate) {
    const recommendations = [];
    
    if (dataReceivalRate < 90) {
      recommendations.push('Check serial cable connections and port settings');
    }
    
    if (this.performanceMetrics.dataGaps > 5) {
      recommendations.push('Consider increasing serial buffer size or reducing baud rate');
    }
    
    if (this.performanceMetrics.errors.length > 0) {
      recommendations.push('Review error log for specific hardware issues');
    }
    
    if (this.performanceMetrics.memoryUsage > this.config.performance.maxMemoryMB) {
      recommendations.push('Monitor for memory leaks in experiment code');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('Hardware communication is performing well');
    }
    
    return recommendations;
  }

  /**
   * Start performance monitoring
   */
  startPerformanceMonitoring() {
    // Performance logging timer
    this.performanceTimer = setInterval(() => {
      if (this.testActive) {
        console.log('Performance metrics:', {
          dataPoints: this.performanceMetrics.totalDataPoints,
          dataRate: this.performanceMetrics.averageDataRate.toFixed(2),
          dataGaps: this.performanceMetrics.dataGaps,
          errors: this.performanceMetrics.errors.length
        });
      }
    }, this.config.performance.performanceInterval);
    
    // Memory monitoring timer
    this.memoryTimer = setInterval(() => {
      if (process.memoryUsage) {
        const memUsage = process.memoryUsage();
        this.performanceMetrics.memoryUsage = Math.round(memUsage.heapUsed / 1024 / 1024);
        
        if (this.performanceMetrics.memoryUsage > this.config.performance.maxMemoryMB) {
          console.warn(`High memory usage detected: ${this.performanceMetrics.memoryUsage}MB`);
        }
      }
    }, this.config.performance.memoryCheckInterval);
  }

  /**
   * Custom IPC handlers for hardware testing
   */
  getCustomHandlers() {
    return {
      [this.config.ipcNames.startTest]: async (event, testConfig = {}) => {
        try {
          // Allow runtime test configuration
          if (testConfig.port) this.config.serial.port = testConfig.port;
          if (testConfig.baudRate) this.config.serial.baudRate = testConfig.baudRate;
          if (testConfig.duration) this.config.testParams.testDuration = testConfig.duration;
          
          return await this.startHardwareTest();
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      
      [this.config.ipcNames.stopTest]: async (event) => {
        try {
          return await this.stopHardwareTest('manual');
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      
      [this.config.ipcNames.getTestStatus]: async (event) => {
        return {
          active: this.testActive,
          startTime: this.testStartTime,
          duration: this.testActive ? Date.now() - this.testStartTime : 0,
          dataPoints: this.performanceMetrics.totalDataPoints,
          dataRate: this.performanceMetrics.averageDataRate,
          dataGaps: this.performanceMetrics.dataGaps,
          memoryUsage: this.performanceMetrics.memoryUsage,
          errors: this.performanceMetrics.errors.length
        };
      },
      
      [this.config.ipcNames.getPerformanceMetrics]: async (event) => {
        return {
          metrics: this.performanceMetrics,
          recentData: this.dataReceived.slice(-10), // Last 10 data points
          testConfig: {
            port: this.config.serial.port,
            baudRate: this.config.serial.baudRate,
            expectedRate: this.config.testParams.expectedDataRate
          }
        };
      },
      
      [this.config.ipcNames.resetTest]: async (event) => {
        try {
          if (this.testActive) {
            await this.stopHardwareTest('reset');
          }
          
          // Reset all test state
          this.dataReceived = [];
          this.performanceMetrics = {
            totalDataPoints: 0,
            averageDataRate: 0,
            dataGaps: 0,
            memoryUsage: 0,
            cpuUsage: 0,
            errors: []
          };
          
          return { success: true, message: 'Test state reset successfully' };
        } catch (error) {
          return { success: false, error: error.message };
        }
      }
    };
  }

  /**
   * Cleanup when experiment is unloaded
   */
  async onCleanup() {
    console.log('Cleaning up hardware test experiment...');
    
    try {
      // Stop any running test
      if (this.testActive) {
        await this.stopHardwareTest('cleanup');
      }
      
      // Clear timers
      if (this.performanceTimer) {
        clearInterval(this.performanceTimer);
        this.performanceTimer = null;
      }
      
      if (this.memoryTimer) {
        clearInterval(this.memoryTimer);
        this.memoryTimer = null;
      }
      
      // Release hardware resources
      if (this.logHandle) {
        await this.releaseHardware(this.logHandle);
        this.logHandle = null;
      }
      
      console.log('Hardware test experiment cleaned up successfully');
      
    } catch (error) {
      console.error('Error during hardware test cleanup:', error);
    }
  }
}

// Export configuration for the experiment loader
export const experimentConfig = {
  name: "Real Hardware Test Experiment",
  version: "1.0.0",
  description: "Validates modular architecture with actual hardware communication and performance testing",
  
  hardware: {
    required: ["serial-port", "data-logging"],
    optional: []
  },
  
  // Test scenarios this experiment supports
  testScenarios: {
    quickTest: { duration: 30000, expectedRate: 10 },
    standardTest: { duration: 60000, expectedRate: 20 },
    stressTest: { duration: 300000, expectedRate: 50 }
  },
  
  // Default configuration for hardware testing
  defaultConfig: {
    serial: {
      port: 'COM3',
      baudRate: 115200,
      timeout: 5000
    },
    testParams: {
      testDuration: 60000,
      expectedDataRate: 20,
      validateDataIntegrity: true
    }
  }
};