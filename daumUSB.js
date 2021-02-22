const EventEmitter = require('events').EventEmitter;
const SerialPort = require('serialport');
const DaumSIM = require('./daumSIM');
const Logger = require('./logger');
const config = require('config-yml');
const InterByteTimeout = require('@serialport/parser-inter-byte-timeout');

// instantiation
const daumSIM = new DaumSIM();
const logger = new Logger('daumUSB.js');

function daumUSB () {
  const self = this;
  self.port = null;
  self.parser = null;
  self.emitter = new EventEmitter();
  self.failures = 0;

  // this script is looking for the address, this is working, for default, I'll set this to 00
  let daumCockpitAdress = config.daumCockpit.adress;
  // false by default to scan for cockpit address; if address cannot be retrieved, there will be no interaction with daum.
  let gotAdressSuccess = config.mock.daumUSB ? true : config.daumCockpit.gotAdressSuccess;

  // write data to port
  this.write = function (string) {
    logger.debug('this.write - [OUT]: ' + string.toString('hex'));
    if (self.port) {
      const buffer = new Buffer.from(string);
      self.port.write(buffer);
    } else {
      logger.warn('this.write - Communication port is not open - not sending data: ' + string);
    }
  };

  this.getResponseHeader = (data) => {
    let address = data[1].toString(16);
    if (address.length === 1) {
      address = '0' + address;
    }
      return data[0].toString(16) + address;  // 1. Byte: Command; 2. Byte: Cockpit-Address
  };

  // used when port open to get data stream from buffer and grab the values, e.g. speed, rpm,...
  this.readAndDispatch = function (numbers) {
    logger.debug('readAndDispatch - [IN]: ' + numbers.toString('hex'));
    self.emitter.emit('raw', numbers);
    let states = numbers;
    const data = {};
    let failure = false;

    if (gotAdressSuccess === false) {
      if (self.checkAdressResponse(numbers)) {
        // get the address from the stream by using the index
        daumCockpitAdress = (states[1]).toString();
        logger.debug('getAdress - [Adress]: ' + daumCockpitAdress);
        self.emitter.emit('key', '[daumUSB.js] - getAdress - [Adress]: ' + daumCockpitAdress);

        // address is retrieved, lets set this to true to inform other functions that they can proceed now
        gotAdressSuccess = true;

        // timeout is necesarry to changes gears back to 1;
        // there is an invalid value send, that sets gear 17 = 0x11,
        // this should be filtered before data is read, but does not work
        setTimeout(self.start, config.timeouts.start);
        logger.debug('getAdress - [gotAdressSuccess]: ' + gotAdressSuccess);

      } else {
        logger.debug('no address found. retrying command to get address...');
        setTimeout(() => self.getAdress(), config.intervals.getAdress);
      }
    } else {
      // Check first two bytes to assign response data to previously sent command
      switch(self.getResponseHeader(numbers)) {
        case config.daumCommands.check_Cockpit + daumCockpitAdress:
          logger.debug('check cockpit response');
          break;
        case config.daumCommands.set_Gear + daumCockpitAdress:
          logger.debug('check cockpit response');
          break;
        case config.daumCommands.set_Prog + daumCockpitAdress:
          logger.debug('set program response');
          break;

        case config.daumCommands.run_Data + daumCockpitAdress:
          if (self.checkRunData(states)) {
            // const cadence = (states[6])
            // if (!isNaN(cadence) && (cadence >= config.daumRanges.min_rpm && cadence <= config.daumRanges.max_rpm)) {
            //   data.cadence = cadence
            // }
            // const hr = 99 // !!! can be deleted - have to check BLE code on dependencies
            // if (!isNaN(hr)) { data.hr = hr } // !!! can be deleted - have to check BLE code on dependencies
            const rpm = (states[6]);
            if (!isNaN(rpm) && (rpm >= config.daumRanges.min_rpm && rpm <= config.daumRanges.max_rpm)) {
              if (rpm - global.globalrpm_daum >= config.daumRanges.rpm_threshold) {
                logger.debug('rpm_threshold overflow');
                failure = true;
              } else {
                data.rpm = rpm;
                global.globalrpm_daum = data.rpm // global variables used, because I cannot code ;)
              }
            }

            let gear = (states[16]);
            if (!isNaN(gear) && (gear >= config.daumRanges.min_gear && gear <= config.daumRanges.max_gear)) {
              if (failure) {
                data.gear = global.globalgear_daum;
              } else {
                // because Daum has by default 28 gears, check and overwrite if gpio maxGear is lower
                if (gear > config.gpio.maxGear) {
                  // ceiling the maxGear with parameter
                  gear = config.gpio.maxGear;
                  // overwrite gear to Daum
                  self.setGear(gear);
                }
                data.gear = gear;
                global.globalgear_daum = data.gear; // global variables used, because I cannot code ;)
              }
            }

            const program = (states[2]);
            if (!failure && !isNaN(program) && (program >= config.daumRanges.min_program && program <= config.daumRanges.max_program)) {
              data.program = program;
            }

            let power = 0;
            // power - 25 watt will always be transmitted by daum;
            // set to 0 if rpm is 0 to avoid rolling if stand still in applications like zwift or fullgaz
            if (rpm === 0) {
              data.power = power;
            } else {
              power = (states[5]);
              if (!isNaN(power) && (power >= config.daumRanges.min_power && power <= config.daumRanges.max_power)) {
                if (failure || power >= config.daumRanges.power_threshold) {
                  logger.debug('power_threshold overflow');
                  data.power = global.globalpower_daum;  // let's take the last known value
                } else {
                  // multiply with factor 5, see Daum spec
                  data.power = power * config.daumRanges.power_factor;
                  global.globalpower_daum = data.power;
                }
              }
            }

            // calculating the speed based on the RPM to gain some accuracy; speed signal is only integer
            // as long as the gearRatio is the same as in the spec of DAUM,
            // the actual speed on the display and the calculated one will be the same
            // DAUM: the ratio starts from 42:24 and ends at 53:12; see TRS_8008 Manual page 16
            // const gearRatio = config.gears.ratioLow + (data.gear - 1) * config.gears.ratioHigh
            const gearRatio = config.gearbox['g' + data.gear];                      // 1,75 + ( gl_Gang -1 )* 0.098767
            const distance = gearRatio * config.gears.circumference;                // distance in cm per rotation
            const speed = data.rpm * distance * config.gears.speedConversion;       // speed in km/h
            // const speed = (states[7])

            if (!isNaN(speed) && (speed >= config.daumRanges.min_speed && speed <= config.daumRanges.max_speed)) {
              // reduce number of decimals after calculation to 1
              data.speed = Number(speed).toFixed(1);
              global.globalspeed_daum = data.speed; // global variables used, because I cannot code ;)

              // run power simulation here in parallel to server.js to enhance resolution of resistance,
              // e.g.: ble only triggers sim once per second, but if you pedal faster, this needs to be here.
              if (global.globalmode === 'SIM') {
                daumSIM.physics(global.globalwindspeed_ble, global.globalgrade_ble, global.globalcrr_ble, global.globalcw_ble, global.globalrpm_daum, global.globalspeed_daum, global.globalgear_daum);
                self.setPower(Number(global.globalsimpower_daum).toFixed(0));
              }
            }

            // emit data for further use
            if (Object.keys(data).length > 0) {
              self.emitter.emit('data', data);
            }

            setTimeout(() => self.runData(), config.intervals.runData);
          }
          break;

        default:
          self.failures++;
          logger.error('Unrecognized packet: ' + numbers.toString('hex'));
          self.emitter.emit('error', '[daumUSB.js] - Unrecognized packet: ' + numbers.toString('hex'));
          logger.debug('Failures: ' + self.failures);

          logger.info('no valid response found. retrying command to get run data...');
          setTimeout(() => self.runData(), config.intervals.runData);
      }
    }
  };

  this.checkAdressResponse = (states) => {
    return states.length === 2 && states[0].toString(16) === config.daumCommands.get_Adress;
  };

  this.checkRunData = function (states) {
    const i = 0;

    return (parseHexToInt(states[i + 2]) === config.daumRanges.manual_program &&      // 3. Byte: Valid Program (here: manual)
      parseHexToInt(states[i + 3]) <= config.daumRanges.max_Person &&           // 4. Byte: Valid Person
      parseHexToInt(states[i + 5]) >= config.daumRanges.min_power &&            // 6. Byte: Valid Power Range
      parseHexToInt(states[i + 5]) <= config.daumRanges.max_power &&
      parseHexToInt(states[i + 6]) >= config.daumRanges.min_rpm &&              // 7. Byte: Valid RPM
      parseHexToInt(states[i + 6]) <= config.daumRanges.max_rpm &&
      parseHexToInt(states[i + 7]) >= config.daumRanges.min_speed &&            // 8. Byte: Valid Speed Range
      parseHexToInt(states[i + 7]) <= config.daumRanges.max_speed &&
      parseHexToInt(states[i + 16]) >= config.daumRanges.min_gear)              // 17. Byte: Valid Gear Range
      // && parseHexToInt(states[i + 16]) <= config.daumRanges.max_gear);
  };

  // open port as specified by daum
  this.open = function () {
    if (config.mock.daumUSB) {
      self.openPort('/dev/ROBOT', 'MOCK_VENDOR', 'MOCK_PRODUCT');
    } else {
      SerialPort.list().then((ports) => {
        ports.forEach(function (p) {
          // ??? don't know if this is the ID of ergobike, or the serial adapter,
          // this has to be configured for every bike, so I might skip it
          if (p.vendorId && p.productId) {
            self.openPort(p.path, p.vendorId, p.productId);
          }
        })
      }, (err) => {
        self.emitter.emit('error', '[daumUSB.js] - open: ' + err);
        throw err;
      });
    }

    return self.emitter;
  };

  this.openPort = (path, vendorId, productId) => {
    logger.debug('open - ' + vendorId + '  ' + productId); // RS232 converter Ids
    logger.debug('open - Ergobike found on port ' + path);
    self.emitter.emit('key', '[daumUSB.js] - Ergobike found on port ' + path);

    if (config.mock.daumUSB) {
      const MockBinding = require('@serialport/binding-mock');
      SerialPort.Binding = MockBinding;

      // Create a port and enable the echo and recording.
      MockBinding.createPort(path, {echo: true, record: true});
    }

    self.port = new SerialPort(path, {
      autoOpen: false,
      baudRate: config.port.baudrate,
      dataBits: config.port.dataBits,
      parity: config.port.parity,
      stopBits: config.port.stopBits,
      rtscts: config.port.flowControl,
    });

    self.parser = self.port.pipe(new InterByteTimeout({interval: config.port.interval}));

    // try open
    self.internalOpen();

    self.port.on('open', () => {
      logger.debug('the serialport has been opened!');
      self.parser.on('data', self.readAndDispatch);
      self.port.drain();

      if (gotAdressSuccess === false) {
        // check, otherwise after a restart via webserver, this will run again
        logger.debug('looking for cockpit address');
        self.emitter.emit('key', '[daumUSB.js] - looking for cockpit address');

        // get address from ergobike
        self.getAdress();
      }
    });

    self.port.on('close', () => {
      logger.debug('the serialport has been closed!')
    });
  };

  this.internalOpen = () => {
    self.port.open((err) => {
      if (!err) {
        return;
      }
      console.logger.debug('port is not open, retry in 10s');
      setTimeout(() => this.internalOpen(), config.intervals.openPort);
    });
  };

  // restart port
  this.restart = function () {
    logger.debug('Daum restart');
    self.failures = 0;

    self.stop();
    setTimeout(self.open, config.timeouts.open);
    setTimeout(self.start, config.timeouts.start);
  };

  // start sequence - this is just a dummy, because getAdress is used during port initialization
  // set gear as second, to enable switching gears with jog wheel or buttons in cockpit by default
  this.start = function () {
    // reset to program 0
    self.setProgram(0);
    self.emitter.emit('key', '[daumUSB.js] - setProgram to 0');

    // reset the gears
    // this forces daum cockpit to change gears instead of power when using the buttons or the jog wheel
    self.setGear(config.daumRanges.min_gear);
    self.emitter.emit('key', '[daumUSB.js] - setGear to minimum gear');
  };

  // stop port - no start function, use restart after stop
  this.stop = function () {
    if(self.port.isOpen) {
      self.port.close();
    }
  };

  // set daum command function - general function for sending data - still testing
  this.setDaumCommand = function (command, adress, sendData) {
    if (command !== config.daumCommands.get_Adress) {
      if (gotAdressSuccess === true) {
        logger.debug('set command [0x' + command + ']: ' + sendData);

        if (sendData === 'none') {
          // this is for commands that just have command and address - no data
          const datas = Buffer.from(command + ('00' + (adress).toString()).slice(-2), 'hex');
          self.write(datas);
        } else {
          // this is for commands that have command, address and data
          const datas = Buffer.from(command + ('00' + (adress).toString()).slice(-2) + ('00' + (sendData).toString(16)).slice(-2), 'hex');
          self.write(datas);
        }

      } else {
        // if no cockpit address found, just post the message and not execute the command
        logger.debug('cannot set command [0x' + command + '] - no cockpit address');
        self.emitter.emit('error', '[daumUSB.js] - cannot set command [0x' + command + '] - no cockpit address');
      }
    } else {
      // this is just for get address
      const datas = Buffer.from(command, 'hex');
      self.write(datas);
    }
  };

  // get cockpit adress - simplified by using setDaumCommand function
  this.getAdress = function () {
    logger.debug('getAdress');
    self.emitter.emit('key', '[daumUSB.js] - getAdress');

    self.setDaumCommand(config.daumCommands.get_Adress, 'none', 'none');
  };

  // get person data 1
  this.getPersonData = function () {
    self.setDaumCommand(config.daumCommands.get_PersonData, daumCockpitAdress, 'none');
  };

  // get 'run_Data' from ergobike
  this.runData = function () {
    logger.debug('runData');
    self.emitter.emit('key', '[daumUSB.js] - runData');

    self.setDaumCommand(config.mock.daumUSB ?
      mockRunData() :
      config.daumCommands.run_Data, daumCockpitAdress, 'none');
  };

  // set the power resistance
  this.setPower = function (power) {
    // power validation is done here to don't loose quality in other functions
    if (power < config.daumRanges.min_power * config.daumRanges.power_factor) {
      // cut negative or too low power values from simulation
      power = config.daumRanges.min_power * config.daumRanges.power_factor;
    }

    if (power > config.daumRanges.max_power * config.daumRanges.power_factor) {
      // cut too high power calculations
      power = config.daumRanges.max_power * config.daumRanges.power_factor;
    }
    // round up and to step of 5 to match daum spec and devide by 5
    const ergopower = Math.round(power / config.daumRanges.power_factor);
    self.setDaumCommand(config.daumCommands.set_Watt, daumCockpitAdress, ergopower);
  };

  // set a program
  this.setProgram = function (programID) {
    self.setDaumCommand(config.daumCommands.set_Prog, daumCockpitAdress, programID);
  };

  // set watt profile / increment or decrement 5 watt
  this.setWattProfile = function (profile) {
    self.setDaumCommand(config.daumCommands.set_WattProfile, daumCockpitAdress, profile);
  };

  // set a gear
  this.setGear = function (gear) {
    self.setDaumCommand(config.daumCommands.set_Gear, daumCockpitAdress, gear);
  };
  // to string ????????? - self.toString is not used here
  this.toString = function () {
    return 'Daum on ' + self.port.path;
  }
}

function parseHexToInt(hex) {
  return parseInt(hex.toString(16), 16);
}

function mockGetAdress () {
  return new Buffer.from('1100');
}

function mockRunData () {
  const temp = 70 + Math.floor(Math.random() * 5);
  const rpm = temp.toString(16);

  return new Buffer.from('400000000019' + rpm + '1D0000000000000000040000');
}

module.exports = daumUSB;
