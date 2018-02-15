const util = require("util");

const pref = "GPIO";

module.exports = {
  readTele: function(tele, readMap, houser) {
    if (!tele ) return;
    let unitid = 'wip1';

    if (typeof tele == 'object' && tele.type == 'channels' && tele.data && tele.data.length > 0) {
        let cid = tele.data[0].cid; 
        // Считать channels
        let charr = houser.jdbGet({ name: 'channels/' + String(unitid).toLowerCase() });

        // Взять все cid кроме текущего + принятые
        let newdata = charr.filter(item => (item.cid != cid)).concat(tele.data);

        return {type:'channels', data:newdata};
    } else {
        return tele;
    }

  }
};
