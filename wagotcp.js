/**
* TCP сервер для контроллеров WAGO
* wtcp4.js - Version 4. Бинарные данные
*
* Входящие данные c контроллера:
* Пакет с описанием переменных
* { name:wagoname, vars:[{n:"AX_1", d:"AI", ad:12345 },.. ad- адрес переменной

* Состояние
* Пакет текущих данных - бинарные данные по 16 байт

* Пакет архивных данных 

* Управление
* Бинарное переключение (on/off)
* v1  <250><S><A><M><E><N><A><M><E>...<:><t><r><u><e><0> 
* v2  <250><1><2><5><:><E><O><:><t><r><u><e><0> 
**/

var net = require('net');
var util = require('util');
// var fs = require('fs');

const chandle = '_handle';


// 1 байт в сообщении контроллеру
var OK_ANS = 200;
var ERR_ANS = 201;
var CMD = 250;

// 1 байт входящих бинарных сообщений
var DATA = 100;
var HIST = 101;
// var DATASIZE = 16; // размер фрагмента пакета, содержащего одно сообщение

// Логгирование
// var plogger;
var logsection = { raw: 0, format: 1, config: 1, bin: 0, json: 0, data: 0, result: 0, ack: 0, command: 1, connect: 1, hist: 0, select: 0 };

// Хранение входящих данных:  iodata[cid][adr] = {ts:ts, value:v, name:n, desc:d}
// var iodatafilename = 'iodataWIP.json';
// var iodata = restoreIodata();
var iodata = {}; // Теперь получаем с сервера

var clients = {}; // Подключенные сокеты: clients[cid] = connectedObj;
var astates = {};
var chunk = {}; // Неполные сообщения от клиентов: { bin:[до 16 байт], data:string }
var dataChunk = '';

const unitId = process.argv[2];

// Реальные значения параметров получаем с сервера, здесь значения по умолчанию
const unitParams = { port: 8123 };

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
      step = 3;
      break;
    default:
  }
}

function getTable(name) {
  process.send({ type: 'get', tablename: name + '/' + unitId });
}

/** TCP сервер. 
*
*   Для сокетов используется механизм keepalive.
*   Потеря связи с сокетом определяется через довольно большой промежуток времени (11 мин 30 сек), при этом происходит событие error, затем close. 
*
*   Как устанавливается этот интервал: http://tldp.org/HOWTO/TCP-Keepalive-HOWTO/usingkeepalive.html
*     LINUX имеет опции для сокета, связанные с keepalive:
*       tcp_keepalive_time   - период между data пакетом и первой keepalive пробой, def 7200 сек (2 часа)
*                              Функция пакет net socket.setKeepAlive(true, 15000) переустанавливает это значение, здесь оно в мс
*                              Фактически время до первой пробы все равно получается 75 сек, м.б. если меньше tcp_keepalive_intvl, то исп-ся он

*       tcp_keepalive_intvl  - период между keepalive пробами, def 75 сек
*       tcp_keepalive_probes - количество проб без ответа, после которой делается вывод о потере соединения, def 9
*                              Эти два параметра модуль net НЕ УСТАНАВЛИВАЕТ?
*                              75*(9 + 1)=11 мин 30 сек 
*                              Можно установить их на уровне OC через sysctl для всех TCP сокетов 
*                                 sudo sysctl -w net.ipv4.tcp_keepalive_probes=3, тогда время 3 мин 45 сек = 75*(1+3)
*        
**/
function serverStart(port) {
  var server = net.createServer(c => {
    c.setKeepAlive(true, 15000);

    // Этот таймаут контролирует только прием данных, keepalive не учитывает
    c.setTimeout(30000, () => {
      traceMsg(showCid(c) + ' client is idle', 'raw');
    });

    // Отключить буферизацию при записи
    c.setNoDelay(true);

    traceMsg('client connected. handle= ' + c[chandle].fd, 'connect');

    /** Прием данных **/
    c.on('data', bdata => {
      var dt = Number(new Date());
      var result;
      var format;

      traceMsg(showCid(c) + ' Getted data:', 'raw');
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

      traceMsg(showCid(c) + ' Data format: ' + format+' packet len='+bdata.length, 'format');

      switch (format) {
        case 'bin':
          result = processBinPacket(bdata);
          break;

        case 'json':
          result = preProcessPacket(bdata.toString(), dt);

          // result = processPacket(bdata.toString(), dt);
          break;

        default:
          result = ERR_ANS;
      }

      // Ответ
      if (result) {
        sendResult(result);
        traceMsg(showCid(c) + ' Result: ' + result, 'result');
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

      // result = ERR_ANS;
      return result;
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

      // traceMsg('bin packet len='+bdata.length, 'format');

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

        } else {
          if (!chunk[c.myid]) {
            chunk[c.myid] = {};
          }

          chunk[c.myid].bin = [];
          chunk[c.myid].bin[0] = first;
          for (var i = index; i < bdata.length; i++) chunk[c.myid].bin.push(bdata[i]);
        }
      }

      fillData(inarr, current, c.myid);
      return OK_ANS;

      function processOne() {
        if (one[0] == 255) return true;

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
          errMsg('Wrong delim! ' + String(delim), 'buffer');
          return;
        }
        if (tms >=1000) tms = 0; // милисекунды не должны быть больше 1000!!!
        inarr.push({ ad: adr, v: val, ts: ts * 1000 + tms });
        return true;
      }
    }

    function processPacket(data, ts) {
      if (checkData(data, c.myid)) {
        if (!c.myid) {
          c.myid = getClientName(data);
          clients[c.myid] = c;
          askConfig(c.myid);
          // process.send({ fun: 'connect', name: getStatusName(c.myid) });
          // process.send({ type: 'data', data:[statusState(c.myid, 1, ts)]});
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
        // process.send({ fun: 'disconnect', name: getStatusName(c.myid) });
        process.send({ type: 'data', data: [statusState(c.myid, 0, Date.now())] });

        // delete clients[c.myid];  - Перенесено в disconnect
      }
    }

    /** Передать ответ - 1 байт **/
    function sendResult(res) {
      var buf;

      if (res) {
        buf = new Buffer(2);
        buf[0] = res;
        buf[1] = 0;
        c.write(buf);
        traceMsg(showCid(c) + ' ACK: ' + String(res), 'ack');
      }
    }
  });

  server.listen(port, () => {
    // 'listening' listener
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
  // traceMsg('Command: ' + util.inspect(message), 'command');
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
      if (!clients[message.id]) throw { message: ' Client with id ' + message.id + ' is not connected. ' };

      if (message.dn.substr(0, 6) == 'STATUS') {
        askConfig(message.id);
      } else {
        sendCommandToSocket(message);
      }
    } catch (e) {
      traceMsg('Error write to socket for command ' + JSON.stringify(message) + '. ' + e.message, 'command');
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
    default:
  }
}

function doAct(data) {
  if (!data || !util.isArray(data) || data.length <= 0) return;

  // {id, cid, adr, val}
  data.forEach(item => {
    sendCommandToSocket(item);
  });
}

// Сервер прислал параметры - взять которые нужны
function paramResponse(param) {
  if (typeof param == 'object') {
    if (param.port) unitParams.port = param.port;
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
  traceMsg( util.inspect(iodata), 'config');
  next();
}

/**
* Binary format: <1byte CMD><4bytes adr><4bytes val><2byte type><FF>
*  {id, cid, adr, val}
**/
function sendCommandToSocket({ id, cid, adr, value, desc }) {
  if (typeof cid == undefined) throw { message: ' Invalid command cid! Channel ' + id };
  if (typeof adr == undefined) throw { message: ' Invalid command adr! Channel ' + id };
  if (typeof value == undefined) throw { message: ' Invalid command value! Channel ' + id };

  var type;
  var buf = new Buffer(12);

  if (!clients[cid]) throw { message: ' Client is not connected: ' + cid };

  // по названию найти адрес

  // adr = getAdr(message.id, message.dn + '_' + message.id);
  type = getTypeByteByDesc(desc);

  // val = getCommandVal(message.val);

  traceMsg(cid + ' write to socket. adr=' + adr.toString(16) + '  type=' + type + ' val=' + value, 'command');

  buf[0] = CMD;
  buf.writeUInt32LE(adr, 1);
  buf.writeFloatLE(value, 5);
  buf.writeUInt16LE(type, 9);
  buf[11] = 255;

  clients[cid].write(buf);
  // traceMsg('Write to socket ' + clients[cid][chandle].fd);
}

/*
function getCommandVal(val) {
  if (val === 'true') {
    return 1;
  }

  if (val === 'false') {
    return 0;
  }

  if (!isNaN(val)) {
    return Number(val);
  }
}

function getAdr(cid, name) {
  for (var adr in iodata[cid]) {
    if (iodata[cid][adr].id == name) {
      return adr;
    }
  }
}

function getTypeByte(cid, adr) {
  if (!iodata || !iodata[cid] || !iodata[cid][adr]) {
    return;
  }

  switch (iodata[cid][adr].desc) {
    case 'DO':
      return 1;
    case 'AO':
      return 3;
    case 'EO':
      return 5;
    default:
  }
}
*/

function getTypeByteByDesc(desc) {
  switch (desc) {
    case 'DO':
      return 1;
    case 'AO':
      return 3;
    case 'EO':
      return 5;
    default:
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
    } catch (e) {
      traceMsg(id + ' ERROR Write to socket ' + clients[id][chandle].fd + ': ' + String(buf[0]));
    }

    traceMsg(id + ' Write to socket ' + clients[id][chandle].fd + ': ' + String(buf[0]));
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

  recobj = JSON.parse(recstr);
  if (!recobj) return;
  if (!cid) return;

  traceMsg(recstr, 'json');
  if (util.isArray(recobj)) {
    // пришел массив актуальных данных
    // traceMsg('GET DATA'+util.inspect(recobj));
    traceMsg('GET DATA', 'select');

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
      traceMsg(cid + ' UPDATE DEVICES ' + util.inspect(recobj.vars, 'config'));
      fillDevlist(recobj.vars);
      // saveIodata(); // Сохранить полученную конфигурацию
    }

    if (recobj.hisdata) {
      traceMsg(cid + ' HISTORY DATA' + util.inspect(recobj.hisdata), 'hist');
      traceMsg('GET HIST ', 'select');
      fillData(recobj.hisdata, false);
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

        // iodata[cid][adr] = { ts: 0, name: stname, desc: inarr[i].d };
        iodata[cid][adr] = { ts: 0, id: stname, desc: inarr[i].d };

        // rarr.push({ name: stname, desc: inarr[i].d });
        rarr.push({ id: stname, desc: inarr[i].d, adr, cid });
      }
    }

    // Добавляем индикатор состояния
    rarr.push({ id: getStatusName(cid), desc: 'status', ts: dt, adr: '0', cid });
    // process.send({ fun: 'devlist', name: cid, list: rarr, gen: 1 });
    traceMsg('GET channels from PLC '+util.inspect(rarr), 'json');
    process.send({ type: 'channels', data: rarr });
  }
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
            darr.push({ id: stname, value: inarr[i].v, ts: inarr[i].ts, err: 0 });
            iodata[cid][adr].value = inarr[i].v;
            iodata[cid][adr].ts = inarr[i].ts;
          } else {

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
  }

  // process.send({ fun: 'data', list: darr, hist: harr });
  process.send({ type: 'data', data: darr });
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
      } else {
        result = result.replace(/\s+/, ''); // убрать пробел
      }
      traceMsg('client name ' + result, 'connect');
    }
  } catch (e) {
    traceMsg('client name ERROR!!');
  }

  return result;
}

// Загрузить сохраненную конфигурацию
/*
function restoreIodata() {
  var data;
  var  result = {};

  if (fs.existsSync(iodatafilename)) {
    try {
      data = fs.readFileSync(iodatafilename,  'utf8');
      result = JSON.parse(data);
    } catch (e) {
      traceMsg('Invalid file ' + iodatafilename);
    }
  }
  return result;
}

function saveIodata() {
  fs.writeFileSync(iodatafilename, JSON.stringify(iodata),'utf8');
}
*/

// Запрашивать не чаще чем раз в 10 сек
function askConfig(cid) {
  var ts = new Date();
  if (!astates[cid] || ts - astates[cid] > 10000) {
    // Передать запрос на конфигурацию
    sendByteToSocket(cid, 240); // askconfig
    astates[cid] = ts;
  }
}

function traceMsg(text, section) {
  /*
  if (plogger && (!section || logsection[section])) {
    plogger.write(text.toString());
  }
  */

  if (!section || logsection[section]) {
    let txt = section ? section + ' ' + text : text;
    process.send({ type: 'log', txt, level: 2 });
  }
 
}

function errMsg(text, section) {
  let txt = section ? section + ' ' + text : text;
  process.send({ type: 'log', txt, level: 0 });
}
