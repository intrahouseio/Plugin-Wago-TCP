// const util = require("util");

module.exports = {
  readTele(tele, readMap, houser) {
    if (!tele) return;

    if (
      typeof tele == "object" &&
      (tele.type == "channels" || tele.command == "channels") &&
      tele.data &&
      tele.data.length > 0
    ) {
      let unitid = tele.unit; // type == "channels", type == "command" должны передавать unit
      let cid = tele.data[0].cid;
      // Считать channels
      let charr = houser.jdbGet({
        name: "channels/" + String(unitid).toLowerCase()
      });

      // Взять все cid кроме текущего + принятые
      let newdata = charr.filter(item => item.cid != cid).concat(tele.data);
      
      //return { type: "channels", data: newdata };
      tele.data = newdata;
    }

    return tele;
  }
};
