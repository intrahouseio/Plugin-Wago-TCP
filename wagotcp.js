/**
 * TCP сервер для контроллеров WAGO
 * wtcp4.js - Version 4. Бинарные данные
 *
 * Входящие данные c контроллера:
 * Пакет с описанием переменных
 * { name:wagoname, vars:[{n:"AX_1", d:"AI", ad:12345 },.. ad- адрес переменной
 *
 * Если переменных много - возможно несколько пакетов с описанием подряд
 * В этом случае каждый пакет дополнительно содержит свойство last
 * { name:wagoname, last:0, vars:[{n:"AX_1", d:"AI", ad:12345 }.... - не последний пакет
 * { name:wagoname, last:1, vars:[{n:"AX_99", d:"AI", ad:56785 }.... - последний пакет
 *
 *
 * Пакет текущих значений - бинарные данные по 16 байт
 * <1byte DATA=100><4bytes adr><4bytes val><4bytes timestamp (sec)><2bytes msec><FF><FF>
 * Пакет архивных данных
 * <1byte HIST=101><4bytes adr><4bytes val><4bytes timestamp (sec)><2bytes msec><FF><FF>
 *
 * Управление
 * Одиночная команда
 *  <1byte CMD=250><4bytes adr><4bytes val><2byte type><FF>
 * Групповая команда (несколько команд подряд)
 *  <1byte GCMD=251><1byte счетчик команд(по 10b)><4bytes adr><4bytes val><2bytes type><4bytes adr><4bytes val><2byte type>....<FF>
 *
 * Передать время на контроллер
 * <1byte SENDTIME=230><2bytes Year><2bytes Month><2bytes date><2bytes hour><2bytes min><2bytes sec>
 *
 */

const net = require('net');
const util = require('util');

const chandle = '_handle';

// Первый байт входящих бинарных сообщений
var DATA = 100;
var HIST = 101;

// Первый байт в сообщении контроллеру
var OK_ANS = 200; // Ответ ОК  1 байт
var ERR_ANS = 201; // Ответ ERR  1 байт
var CMD = 250; // послать команду  1+10 байт
var GCMD = 251; // послать групповую команду 2+10*n байт
var GETCONF = 240; // запрос конфигурации 1 байт
var SENDTIME = 230; // установка времени 1+12 байт
var GETDATA = 220; // запрос данных 1 байт

// Логгирование
var logsection = {
  raw: 0,
  in: 1,
  out: 1,
  format: 1,
  buffer: 0,
  config: 1,
  json: 1,
  data: 0,
  connect: 1,
  hist: false
};
var debug = 'off';

// Хранение входящих данных:  iodata[cid][adr] = {ts:ts, value:v, name:n, desc:d}
var iodata = {}; // Теперь получаем с сервера

var clients = {}; // Подключенные сокеты: clients[cid] = connectedObj;
var astates = {};
var commands = {}; // Команды от сервера на обработке

var chunk = {}; // Неполные сообщения от клиентов: { bin:[до 16 байт], data:string }
var dataChunk = '';

const unitId = process.argv[2];

// Реальные значения параметров получаем с сервера, здесь значения по умолчанию
const unitParams = { port: 8123, sendTimeInterval: 60 };

let step = 0; // Состояния плагина

next();

function next() {
  switch (step) {
    case 0: // Запрос на получение параметров
      getTable('params');
      step = 1;
      break;

    case 1: // Запрос на получение каналов
      getTable('config');
      step = 2;
      break;

    case 2: // Запуск TCP сервера
      serverStart(unitParams.port);
      traceMsg('send time interval set: ' + unitParams.sendTimeInterval, 'out');
      if (unitParams.sendTimeInterval > 0) {
        setInterval(sendTimeAll, unitParams.sendTimeInterval * 1000);
      }
      step = 3;
      break;
    default:
  }
}

function getTable(name) {
  process.send({ type: 'get', tablename: name + '/' + unitId });
}

function serverStart(port) {
  var server = net.createServer(c => {
    c.setKeepAlive(true, 15000);

    // Этот таймаут контролирует только прием данных, keepalive не учитывает
    c.setTimeout(30000, () => {
      traceMsg(showCid(c) + ' client is idle', 'raw');
    });

    // Отключить буферизацию при записи
    c.setNoDelay(true);

    // Буфер команд
    c.acts = [];

    traceMsg('client connected. handle= ' + c[chandle].fd, 'connect');

    /** Прием данных **/
    c.on('data', bdata => {
      var dt = Number(new Date());
      var result;
      var format;

      traceMsg(showCid(c) + ' => Data packet len=' + bdata.length, 'in');
      traceMsg(bdata.toString(), 'raw');

      if (dataChunk) {
        format = 'json';
      } else {
        format = getPacketFormat(bdata[0]);
        if (!format) {
          if (chunk[c.myid] && chunk[c.myid].bin) {
            // Незаконченное сообщение двоичное!!
            format = 'bin';
          } else {
            errMsg('Unknown format of chunk:' + bdata.toString());
            return;
          }
        }
      }

      traceMsg('format: ' + format, 'format');

      switch (format) {
        case 'bin':
          if (clients[c.myid].vars) clients[c.myid].vars = '';
          result = processBinPacket(bdata);
          break;

        case 'json':
          result = preProcessPacket(bdata.toString(), dt);
          // Ответ на конф-ю присылать через 100 мсек - не успевает контроллер!!
          setTimeout(() => {
            sendResult(result);
          }, 100);
          return;

        default:
          result = ERR_ANS;
      }

      if (result) {
        sendResult(result);
      }
    });

    function preProcessPacket(data, dt) {
      var result;
      var j;

      j = data.indexOf(String.fromCharCode(13));
      if (j > 0) {
        // Разделитель найден. Он должен быть!!
        if (processPacket(dataChunk + data.substr(0, j), dt)) {
          data = data.substr(j + 1);
          result = OK_ANS;
        } else {
          // Ошибка в пакете, остальное игнорируем
          data = '';
          result = ERR_ANS;
        }
        dataChunk = '';
      } else if (!processIncompleteData(data)) {
        // Обработка частичной строки
        result = ERR_ANS;
      }
      return result;
    }

    function sendResult(res) {
      c.resultToSend = res;
      if (!c.timerId) {
        sending(c.myid);
      }
    }

    function getPacketFormat(ch) {
      if (ch == DATA || ch == HIST) return 'bin';
      if (checkStartChar(ch)) return 'json';
    }

    /** Конец связи - получен FIN **/
    c.on('end', () => {
      delete clients[c.myid];
      traceMsg(showCid(c) + ' client disconnected (end)', 'connect');
      connectionFinished();
    });

    /** Дескриптор закрывается - обработка конца связи без получения FIN.
     *   НЕТ, сокет сохраняется и восстанавливается без connect!!
     **/
    c.on('close', () => {
      traceMsg(showCid(c) + ' client is closed ', 'connect');
      connectionFinished();
    });

    /** Ошибка связи. Затем генерируется close **/
    c.on('error', () => {
      errMsg(showCid(c) + ' client connection error ', 'connect');
    });

    function showCid(cli) {
      return cli && cli.myid ? cli.myid : '';
    }

    function processBinPacket(bdata) {
      var inarr = [];
      var index;
      var j;
      var current;
      var first;
      var one = new Buffer(16);

      // Есть неполная посылка - объединить буферы
      index = 1; // указатель в bdata

      if (chunk[c.myid] && chunk[c.myid].bin && util.isArray(chunk[c.myid].bin) && chunk[c.myid].bin[0]) {
        first = chunk[c.myid].bin[0];
        for (let i = 1; i < chunk[c.myid].bin.length; i++) {
          j = i - 1;
          one[j] = chunk[c.myid].bin[i];
        }

        index = 0; // указатель в bdata
        j++;
        while (j < 16) {
          one[j] = bdata[index];
          index++;
          j++;
        }
      } else {
        index = 1; // указатель в bdata
        first = bdata[0];
        bdata.copy(one, 0, index, index + 16);
      }

      if (chunk[c.myid]) chunk[c.myid].bin = '';

      current = first == DATA;

      // Здесь м.б. кусочек начальный

      while (index < bdata.length) {
        if (!processOne()) return ERR_ANS;

        if (index + 16 < bdata.length) {
          index += 16;
          bdata.copy(one, 0, index, index + 16);
        } else {
          break;
        }
      }

      // Переписать конец
      if (bdata[index]) {
        if (bdata[index] == 255) {
          //
        } else {
          if (!chunk[c.myid]) {
            chunk[c.myid] = {};
          }

          chunk[c.myid].bin = [];
          chunk[c.myid].bin[0] = first;
          for (var i = index; i < bdata.length; i++) {
            chunk[c.myid].bin.push(bdata[i]);
          }
        }
      }

      fillData(inarr, current, c.myid);
      return OK_ANS;

      function processOne() {
        // if (one[0] == 255) return true;

        let adr = one.readUInt32LE(0);
        let val = one.readFloatLE(4);
        let ts = one.readUInt32LE(8);
        let tms = one.readUInt16LE(12);
        let delim = one.readUInt16LE(14);

        // Округлить значение если с десятичными
        val = Math.round(val * 100) / 100;

        traceMsg(showCid(c) + ' adr=' + adr.toString(16) + ' val=' + val + ' ts=' + ts + ' tms=' + tms, 'buffer');

        if (delim != 65535) {
          // ffff
          errMsg('Wrong delim: ' + String(delim)+' Buffer(hex): '+one.toString('hex'));
          return;
        }
        if (tms >= 1000) tms = 0; // милисекунды не должны быть больше 1000!!!
        inarr.push({ ad: adr, v: val, ts: ts * 1000 + tms });
        return true;
      }
    }

    function processPacket(data, ts) {
      if (checkData(data, c.myid)) {
        if (!c.myid) {
          c.myid = getClientName(data);
          clients[c.myid] = c;

          if (unitParams.sendTimeInterval > 0) {
            sendTimeToSocket(c.myid, getDateObj(new Date()));
          }
        }

        processJsonData(data, c.myid, ts);
        return OK_ANS;
      }
    }

    /** Обработка неполного сообщения  **/
    function processIncompleteData(data) {
      var result;
      if (!dataChunk) {
        // Проверить, что первый символ верный
        if (checkStartChar(data[0])) {
          dataChunk = data;
          result = true;
        } else {
          errMsg(showCid(c) + 'processIncompleteData - INVALID START SYMBOL: code=' + Number(data[0]));
        }
      } else {
        // Уже есть неполная строка - просто добавляем
        dataChunk += data;
        result = true;
      }
      return result;
    }

    /** При закрытии соединения -
     *
     * Установить флаг ошибки для  каждого устройства контроллера
     * Установить индикатор состояния связи
     * Удалить сокет из массива - нет, связь может еще восстановиться
     **/
    function connectionFinished() {
      if (c.myid) {
        process.send({
          type: 'data',
          data: [statusState(c.myid, 0, Date.now())]
        });

        // delete clients[c.myid];  - Перенесено в disconnect
      }
    }
  });

  server.listen(port, () => {
    traceMsg('TCP server port:' + port + ' has bound.');
  });

  server.on('error', e => {
    var mes = e.code == 'EADDRINUSE' ? 'Address in use' : +e.code;
    errMsg('TCP server port:' + port + ' error ' + e.errno + '. ' + mes);
    process.exit(1);
  });
}

/** Обработка команд от основного процесса
 */
process.on('message', message => {
  if (!message) return;

  if (typeof message == 'string') {
    if (message == 'SIGTERM') {
      process.exit(0);
    }
    return;
  }

  if (typeof message == 'object') {
    try {
      if (message.type) return parseMessageFromServer(message);

      // Послать клиенту команду.
      if (!message.id) throw { message: ' Not found "id" property.' };
      if (!message.dn) throw { message: ' Not found "dn" property.' };
      if (!message.val) throw { message: ' Not found "val" property.' };
      if (!clients[message.id])
        throw {
          message: ' Client with id ' + message.id + ' is not connected. '
        };

      if (message.dn.substr(0, 6) == 'STATUS') {
        askConfig(message.id);
      } else {
        sendCommandToSocket(message);
      }
    } catch (e) {
      traceMsg('Command FAIL. ' + JSON.stringify(message) + '. ' + e.message);
    }
  }
});

function parseMessageFromServer(message) {
  switch (message.type) {
    case 'get':
      if (message.params) paramResponse(message.params);
      if (message.config) configResponse(message.config);
      break;

    case 'act':
      doAct(message.data);
      break;

    case 'command':
      doCommand(message);
      break;

    case 'debug':
      debug = message.mode;
      if (debug == 'on') {
        traceMsg('Debug on. Connected PFC: ' + Object.keys(clients).join(','));
      }
      break;

    default:
      traceMsg('Unknown message type: ' + JSON.stringify(message));
  }
}

//
function doCommand(message) {
  traceMsg('Get command: ' + JSON.stringify(message));

  if (!message.id) return commandFail('Expected channel id!');

  let cid = getCidFromChanId(message.id);
  if (!cid) return commandFail('Invalid  channel id!');

  if (!clients[cid]) return commandFail('PFC ' + cid + ' not connected!');

  switch (message.command) {
    case 'channels':
      askConfig(cid);
      // Здесь ответ д б после чтения конфигурации!!!
      // Взвести также таймаут до получения ответа. Если ответа нет - сброс запроса и ответ на сервер
      commands[cid] = message;
      setTimeout(() => {
        if (commands[cid]) {
          commandFail('No response from PFC ' + cid);
          delete commands[cid];
        }
      }, 2000);
      break;

    case 'getdata':
      askData(cid); // GETDATA
      // Сразу отправим ответ, т к данные придут как обычно
      process.send(Object.assign({ response: 1 }, message));
      break;

    default:
      commandFail('Unknown command: ' + message.command);
  }

  function commandFail(errstr) {
    message.response = 0;
    message.message = errstr;
    process.send(message);
    traceMsg(JSON.stringify(message));
  }
}

function getCidFromChanId(chanid) {
  return chanid.split('_').pop();
}

function doAct(data) {
  if (!data || !util.isArray(data) || data.length <= 0) return;

  // Группировать по контроллерам
  const cset = {};
  data.forEach(item => {
    // item : {id, cid, adr, val}
    try {
      const id = item.id;
      if (item.cid == undefined) throw { message: ' Invalid command cid! Channel ' + id };
      if (item.adr == undefined) throw { message: ' Invalid command adr! Channel ' + id };
      if (item.value == undefined) throw { message: ' Invalid command value! Channel ' + id };
      if (!clients[item.cid]) throw { message: ' Client is not connected: ' + item.cid };
      item.type = getTypeByteByDesc(item.desc);

      clients[item.cid].acts.push(item);
      cset[item.cid] = 1;
    } catch (e) {
      traceMsg('FAIL Command ' + JSON.stringify(item) + ': ' + e.message);
    }
  });

  // Если таймер уже взведен - ничего не делаем, просто накапливаем команды
  Object.keys(cset).forEach(cid => {
    if (clients[cid] && !clients[cid].timerId) {
      sending(cid);
    }
  });
}

function sending(cid) {
  if (!clients[cid]) return;

  if (clients[cid].resultToSend) {
    sendResultToSocket(cid, clients[cid].resultToSend);
    clients[cid].resultToSend = 0;
    // Взвести таймер для следующей отправки
    clients[cid].timerId = setTimeout(sending, 100, cid);
  } else {
    if (clients[cid].acts && clients[cid].acts.length > 0) {
      if (clients[cid].acts.length == 1) {
        sendCommandToSocket(clients[cid].acts[0]);
      } else sendGCommandToSocket(cid, clients[cid].acts);

      // Взвести таймер для следующей отправки
      clients[cid].timerId = setTimeout(sending, 100, cid);
    } else {
      clients[cid].timerId = 0;
    }
    clients[cid].acts = [];
  }
}

// Сервер прислал параметры - взять которые нужны
function paramResponse(param) {
  if (typeof param == 'object') {
    if (param.port) unitParams.port = param.port;
    if (param.sendTimeInterval != undefined) unitParams.sendTimeInterval = param.sendTimeInterval;
  }
  next();
}

// Сервер прислал каналы  - сформировать iodata
function configResponse(config) {
  if (typeof config == 'object') {
    if (!util.isArray(config)) config = [config];
    config.forEach(item => {
      if (item.id && item.cid && item.adr) {
        if (!iodata[item.cid]) iodata[item.cid] = {};
        iodata[item.cid][item.adr] = { id: item.id, desc: item.desc, ts: 0 };
      } else {
        traceMsg('Error channel:' + util.inspect(item) + ' Expected id, cid and adr!');
      }
    });
  }
  traceMsg('GET CHANNELS from server: \n' + util.inspect(iodata), 'config');
  next();
}

/** Передать ответ - 1 байт **/
function sendResultToSocket(cid, res) {
  if (!clients[cid]) throw { message: ' Client is not connected: ' + cid };

  var buf;
  if (res) {
    buf = new Buffer(2);
    buf[0] = res;
    buf[1] = 0;
    traceMsg(cid + ' <= Result: ' + String(res), 'out');
    clients[cid].write(buf);
  }
}

/**
 * Binary format: <1byte CMD><4bytes adr><4bytes val><2byte type><FF>
 *  {id, cid, adr, val}
 **/
function sendCommandToSocket({ cid, adr, value, type }) {
  if (!clients[cid]) throw { message: ' Client is not connected: ' + cid };

  const buf = new Buffer(12);
  buf[0] = CMD;
  buf.writeUInt32LE(adr, 1);
  buf.writeFloatLE(value, 5);
  buf.writeUInt16LE(type, 9);
  buf[11] = 255;

  traceMsg(cid + ' <= write bin: ' + CMD + ' adr=' + adr.toString(16) + '  type=' + type + ' val=' + value, 'out');
  clients[cid].write(buf);
}

function sendGCommandToSocket(cid, data) {
  if (!clients[cid]) throw { message: ' Client is not connected: ' + cid };

  const buf = new Buffer(2 + data.length * 10);

  buf[0] = GCMD;
  buf[1] = data.length;
  data.forEach((item, idx) => {
    buf.writeUInt32LE(item.adr, idx * 10 + 2);
    buf.writeFloatLE(item.value, idx * 10 + 6);
    buf.writeUInt16LE(item.type, idx * 10 + 10);
    traceMsg(
      cid + ' <= write bin: ' + GCMD + ' adr=' + item.adr.toString(16) + '  type=' + item.type + ' val=' + item.value,
      'out'
    );
  });
  buf[2 + data.length * 10] = 255;

  clients[cid].write(buf);
}

function getTypeByteByDesc(desc) {
  switch (desc) {
    case 'DO':
      return 1;
    case 'AO':
      return 3;
    case 'EO':
      return 5;
    default:
      return 0;
  }
}

function sendByteToSocket(id, abyte) {
  var buf;

  if (abyte) {
    buf = new Buffer(2);
    buf[0] = abyte;
    buf[1] = 0;

    try {
      clients[id].write(buf);
      traceMsg(id + ' =>  write byte: ' + String(buf[0]), 'out');
    } catch (e) {
      traceMsg(id + ' ERROR Write to socket ' + clients[id][chandle].fd + ': ' + String(buf[0]));
    }
  }
}

function sendTimeAll() {
  let datobj = getDateObj(new Date());
  Object.keys(clients).forEach(cid => {
    sendTimeToSocket(cid, datobj);
  });
}

function sendTimeToSocket(cid, { year, month, date, hour, min, sec }) {
  if (!clients[cid]) return;

  var buf = new Buffer(13);
  buf[0] = SENDTIME;
  buf.writeUInt16LE(year, 1);
  buf.writeUInt16LE(month, 3);
  buf.writeUInt16LE(date, 5);
  buf.writeUInt16LE(hour, 7);
  buf.writeUInt16LE(min, 9);
  buf.writeUInt16LE(sec, 11);
  //buf[11] = 255;

  try {
    clients[cid].write(buf);
    traceMsg(cid + ' <=  write time: ' + year + ' ' + month + ' ' + date + ' ' + hour + ' ' + min + ' ' + sec, 'out');
  } catch (e) {
    traceMsg(cid + ' ERROR write time to socket ' + clients[cid][chandle].fd);
  }
}

/** ********************************************************************/
function checkData(recstr, id) {
  var recobj;

  try {
    if (!checkStartChar(recstr[0])) throw { message: 'Expected start symbol { or [. Received ' + recstr[0] };

    recobj = JSON.parse(recstr);
    if (!recobj) throw { message: 'Invalid JSON format' };

    // массив содержит данные, id должен быть!!
    if (util.isArray(recobj)) {
      if (!id) throw { message: ' Unknown socket ID for data array' };
    } else if (!id && !recobj.name) {
      // в объекте д.б. name
      throw { message: ' Missing name in received object' };
    }

    return true;
  } catch (e) {
    traceMsg(id + ' Error data packet:  ' + recstr + ' ' + e.message);
  }
}

function checkStartChar(ch) {
  return ch == '{' || ch == '[' || ch == 123;
}

function processJsonData(recstr, cid, dt) {
  var recobj;

  traceMsg(recstr, 'json');
  recobj = JSON.parse(recstr);
  if (!recobj) return;
  if (!cid) return;

  if (util.isArray(recobj)) {
    // пришел массив актуальных данных
    if (iodata[cid]) {
      fillData(recobj, true);
    } else {
      // запросить конфигурацию
      askConfig(cid);
    }
  } else {
    // Конфигурация
    if (!iodata[cid]) iodata[cid] = {};

    if (recobj.vars && util.isArray(recobj.vars)) {
      if (recobj.last != undefined) {
        fillMultiPartDevlist(recobj.vars, recobj.last);
      } else {
        fillDevlist(recobj.vars);
      }
    }

    if (recobj.hisdata) {
      traceMsg(cid + ' HISTORY DATA' + util.inspect(recobj.hisdata), 'hist');
      fillData(recobj.hisdata, false);
    }
  }

  function fillMultiPartDevlist(inarr, last) {
    if (!clients[cid]) return;

    if (!clients[cid].vars) clients[cid].vars = [];

    var stname;
    var adr;

    for (var i = 0; i < inarr.length; i++) {
      if (inarr[i].n && inarr[i].ad && inarr[i].d) {
        stname = inarr[i].n + '_' + cid;
        adr = String(inarr[i].ad);

        iodata[cid][adr] = { ts: 0, id: stname, desc: inarr[i].d };
        clients[cid].vars.push({ id: stname, desc: inarr[i].d, adr, cid });
      }
    }
    traceMsg('GET channels from PFC (multipart)');

    if (last) {
      sendChannelsToServer(cid, clients[cid].vars);
      clients[cid].vars = '';
    }
  }

  function fillDevlist(inarr) {
    var rarr = [];
    var stname;
    var adr;

    for (var i = 0; i < inarr.length; i++) {
      if (inarr[i].n && inarr[i].ad && inarr[i].d) {
        stname = inarr[i].n + '_' + cid;
        adr = String(inarr[i].ad);

        iodata[cid][adr] = { ts: 0, id: stname, desc: inarr[i].d };
        rarr.push({ id: stname, desc: inarr[i].d, adr, cid });
      }
    }
    traceMsg('GET channels from PFC');

    // Добавляем индикатор состояния
    rarr.push({
      id: getStatusName(cid),
      desc: 'status',
      ts: dt,
      adr: '0',
      cid
    });

    // Если получили по запросу - отдать в формате type:command, command:channels
    let msg;
    if (commands[cid] && commands[cid].command == 'channels') {
      msg = Object.assign({ unit: unitId, data: rarr, response: 1 }, commands[cid]);
      delete commands[cid];
    } else {
      msg = { unit: unitId, type: 'channels', data: rarr };
    }
    process.send(msg);
    traceMsg('Send to server: ' + JSON.stringify(msg, null, 2));
  }
}

function sendChannelsToServer(cid, rarr) {
  if (!cid || !rarr || !util.isArray(rarr)) return;

  // Добавляем индикатор состояния
  rarr.push({
    id: getStatusName(cid),
    desc: 'status',
    adr: '0',
    cid
  });

  // Если получили по запросу - отдать в формате type:command, command:channels
  let msg;
  if (commands[cid] && commands[cid].command == 'channels') {
    msg = Object.assign({ unit: unitId, data: rarr, response: 1 }, commands[cid]);
    delete commands[cid];
  } else {
    msg = { unit: unitId, type: 'channels', data: rarr };
  }
  process.send(msg);
  traceMsg('Send to server: ' + JSON.stringify(msg, null, 2));
}

function statusState(cid, value, dt) {
  return { id: getStatusName(cid), value, ts: dt };
}

function fillData(inarr, current, cid) {
  var harr = [];
  var darr = [];
  var stname;
  var adr;

  traceMsg(util.inspect(inarr), 'data');
  // Массив может содержать повторы по времени, нужно выбрать с мах временем
  // При этом все данные передаем для записи в БД (harr).
  for (var i = 0; i < inarr.length; i++) {
    if (inarr[i].ad) {
      adr = String(inarr[i].ad);

      if (iodata[cid][adr]) {
        stname = iodata[cid][adr].id;

        harr.push({ id: stname, value: inarr[i].v, ts: inarr[i].ts });
        if (current) {
          if (iodata[cid][adr].ts <= inarr[i].ts) {
            darr.push({
              id: stname,
              value: inarr[i].v,
              ts: inarr[i].ts,
              err: 0
            });
            iodata[cid][adr].value = inarr[i].v;
            iodata[cid][adr].ts = inarr[i].ts;
          }
        }
      } else {
        //
      }
    }
  }

  // Добавляем индикатор состояния
  if (current) {
    var dt = Number(new Date());
    darr.push({ id: getStatusName(cid), value: 1, ts: dt });
    process.send({ type: 'data', data: darr });
  } else {
    traceMsg('HISTDATA, len=' + harr.length + ' \nFirst:' + util.inspect(harr[0]));
    process.send({ type: 'histdata', data: harr });
  }
}

function getStatusName(cid) {
  return 'STATUS_' + cid;
}

function getClientName(recstr) {
  var recobj;
  var result = '';
  try {
    if (recstr[0] == '{') {
      recobj = JSON.parse(recstr);
      result = recobj.name;
      if (!result) throw {};

      if (result.indexOf(':')) {
        // Формат XX:YY:ZZ
        result = result.split(':').join('');
      }

      result = result.replace(/\s+/g, ''); // убрать все пробелы

      traceMsg('client name ' + result, 'connect');
    }
  } catch (e) {
    traceMsg('client name ERROR!!');
  }

  return result;
}

// Запрашивать не чаще чем раз в 10 сек
function askConfig(cid) {
  var ts = new Date();
  if (!astates[cid] || ts - astates[cid] > 10000) {
    // Передать запрос на конфигурацию
    sendByteToSocket(cid, GETCONF); // askconfig
    astates[cid] = ts;
  }
}

function askData(cid) {
  // Передать запрос на данные
  sendByteToSocket(cid, GETDATA);
}

function getDateObj(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    date: date.getUTCDate(),
    hour: date.getUTCHours(),
    min: date.getUTCMinutes(),
    sec: date.getUTCSeconds()
  };
}

function traceMsg(txt, section) {
  if (!section || logsection[section]) {
    process.send({ type: 'log', txt, level: 2 });
  }
}

function errMsg(text, section) {
  let txt = section ? section + ' ' + text : text;
  process.send({ type: 'log', txt, level: 0 });
}
