// parser.js
'use strict';

/**
 * Strips HTML tags and collapses whitespace.
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses the main VPNGate HTML relay server table.
 * @param {string} html 
 * @returns {Array<object>}
 */
function parseVpnGateHtml(html) {
  if (!html || typeof html !== 'string') {
    return [];
  }

  // Find the table that contains the relay hosts.
  // VPNGate pages usually have multiple tables with id="vg_hosts_table_id".
  // The server relay table has headers "Country", "DDNS hostname", and "IP Address".
  const tableRegex = /<table[^>]*id=["']vg_hosts_table_id["'][^>]*>([\s\S]*?)<\/table>/gi;
  let match;
  let mainTableHtml = null;

  while ((match = tableRegex.exec(html)) !== null) {
    const tableBody = match[1];
    if (tableBody.includes('DDNS hostname') || tableBody.includes('Physical location')) {
      mainTableHtml = tableBody;
      break;
    }
  }

  if (!mainTableHtml) {
    console.warn('Could not locate the VPNGate hosts table in the HTML content.');
    return [];
  }

  // Extract all <tr> rows
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  const servers = [];

  while ((trMatch = trRegex.exec(mainTableHtml)) !== null) {
    const rowHtml = trMatch[1];

    // Skip header rows (e.g. rows with class="vg_table_header" or containing <th>)
    if (rowHtml.includes('vg_table_header') || /<th/i.test(rowHtml)) {
      continue;
    }

    // Extract all <td> cells
    const tdMatches = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      tdMatches.push(tdMatch[1]);
    }

    if (tdMatches.length < 10) {
      continue;
    }

    // Col 0: Country / Physical location
    const colCountry = tdMatches[0];
    const countryImgMatch = colCountry.match(/\/([A-Za-z]{2})(?:\(\d+\))?\.png/i);
    const shortCountry = countryImgMatch ? countryImgMatch[1].toUpperCase() : '';
    const countryName = stripHtml(colCountry);

    // Col 1: DDNS hostname / IP Address / (ISP hostname)
    const colHost = tdMatches[1];
    const ipMatch = colHost.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    const ip = ipMatch ? ipMatch[1] : '';

    const ddnsMatch = colHost.match(/([a-zA-Z0-9.-]+\.opengw\.net)/i) ||
                      colHost.match(/<b><span[^>]*>([^<]+)<\/span><\/b>/i);
    const hostname = ddnsMatch ? stripHtml(ddnsMatch[1]) : '';

    const ispMatch = colHost.match(/\(([^)]+)\)/);
    const ispHostname = ispMatch ? stripHtml(ispMatch[1]) : '';

    if (!ip) {
      continue;
    }

    // Col 2: VPN sessions / Uptime / Cumulative users
    const colSessions = tdMatches[2];
    const sessionsMatch = colSessions.match(/(\d[\d,]*)\s*sessions/i);
    const sessionCount = sessionsMatch ? parseInt(sessionsMatch[1].replace(/,/g, ''), 10) : 0;

    const uptimeMatch = colSessions.match(/(\d+\s*(?:days?|hours?|mins?|minutes?))/i);
    const uptimeStr = uptimeMatch ? uptimeMatch[1] : '';

    const usersMatch = colSessions.match(/Total\s*([\d,]+)\s*users/i);
    const userTotalStr = usersMatch ? `Total ${usersMatch[1]} users` : '';

    // Col 3: Line quality (Throughput / Ping / Cumulative transfers / Logging policy)
    const colQuality = tdMatches[3];
    const speedMatch = colQuality.match(/([\d\.]+\s*(?:Mbps|Gbps|Kbps))/i);
    const speedStr = speedMatch ? speedMatch[1] : '';

    const pingMatch = colQuality.match(/Ping:\s*(?:<b>)?\s*(\d+)\s*ms/i);
    const pingMs = pingMatch ? parseInt(pingMatch[1], 10) : null;

    // Cumulative transfer volume: GB/MB/TB/KB (not Mbps/Kbps)
    const transferMatch = colQuality.match(/<b>\s*([\d\.,]+\s*(?:GB|MB|TB|KB))\s*<\/b>/i) ||
                          colQuality.match(/([\d\.,]+\s*(?:GB|MB|TB|KB))(?![a-zA-Z])/i);
    const transfersStr = transferMatch ? transferMatch[1] : '';

    const logPolicyMatch = colQuality.match(/Logging policy:\s*<br>\s*([^<]+)/i) ||
                           colQuality.match(/Logging policy:\s*([^\n<]+)/i);
    const loggingPolicy = logPolicyMatch ? stripHtml(logPolicyMatch[1]) : '';

    // Col 4: SSL-VPN
    const colSsl = tdMatches[4];
    const sslSupported = /SSL-VPN/i.test(colSsl) && !/no_33\.png/i.test(colSsl);
    const sslTcpMatch = colSsl.match(/TCP:\s*(\d+)/i);
    const sslTcpPort = sslTcpMatch ? parseInt(sslTcpMatch[1], 10) : null;
    const sslUdpSupported = /UDP:\s*Supported/i.test(colSsl);

    // Col 5: L2TP/IPsec
    const colL2tp = tdMatches[5];
    const l2tpSupported = /L2TP/i.test(colL2tp) && !/no_33\.png/i.test(colL2tp);

    // Col 6: OpenVPN
    const colOpenVpn = tdMatches[6];
    const openVpnSupported = /OpenVPN/i.test(colOpenVpn) && !/no_33\.png/i.test(colOpenVpn);
    const openVpnLinkMatch = colOpenVpn.match(/href=["']([^"']*do_openvpn\.aspx[^"']*)["']/i);
    let openVpnConfigUrl = '';
    let hid = null;
    let sid = null;

    if (openVpnLinkMatch) {
      let rawUrl = openVpnLinkMatch[1].replace(/&amp;/g, '&');
      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        openVpnConfigUrl = rawUrl;
      } else {
        openVpnConfigUrl = `https://www.vpngate.net/en/${rawUrl.replace(/^\.?\//, '')}`;
      }
      const hidMatch = openVpnConfigUrl.match(/hid=(\d+)/);
      if (hidMatch) hid = hidMatch[1];
      const sidMatch = openVpnConfigUrl.match(/sid=(\d+)/);
      if (sidMatch) sid = sidMatch[1];
    }

    const ovTcpMatch = colOpenVpn.match(/TCP:\s*(\d+)/i);
    const ovTcpPort = ovTcpMatch ? parseInt(ovTcpMatch[1], 10) : null;
    const ovUdpMatch = colOpenVpn.match(/UDP:\s*(\d+)/i);
    const ovUdpPort = ovUdpMatch ? parseInt(ovUdpMatch[1], 10) : null;

    // Col 7: MS-SSTP
    const colSstp = tdMatches[7];
    const sstpSupported = /MS-SSTP/i.test(colSstp) && !/no_33\.png/i.test(colSstp);
    const sstpHostMatch = colSstp.match(/color:\s*#006600;?[^>]*>([^<]+)<\/span>/i) ||
                          colSstp.match(/SSTP Hostname\s*:[\s\S]*?<b>([^<]+)<\/b>/i);
    let sstpHostname = '';
    let sstpPort = null;
    if (sstpHostMatch) {
      const rawSstp = stripHtml(sstpHostMatch[1]);
      if (rawSstp.includes(':')) {
        const parts = rawSstp.split(':');
        sstpHostname = parts[0].trim();
        sstpPort = parseInt(parts[1], 10) || null;
      } else {
        sstpHostname = rawSstp.trim();
        sstpPort = 443;
      }
    } else if (sstpSupported) {
      sstpHostname = hostname;
      sstpPort = 443;
    }

    // Col 8: Operator's Name / Message
    const colOperator = tdMatches[8];
    const operator = stripHtml(colOperator);

    // Col 9: Score (Quality)
    const colScore = tdMatches[9];
    const scoreText = stripHtml(colScore).replace(/,/g, '');
    const score = parseInt(scoreText, 10) || 0;

    // Port and ID determination
    const tcpPort = sstpPort || ovTcpPort || sslTcpPort || 443;
    const udpPort = ovUdpPort || null;
    const primaryPort = tcpPort || udpPort || 443;
    const serverId = hid || sid || ip.replace(/\./g, '');

    // Legacy synthesized fields
    const info = `${sessionCount} SESSIONS ${uptimeStr.toUpperCase()} ${userTotalStr.toUpperCase()}`.trim();
    const info2 = `${shortCountry} ~ ${countryName.toUpperCase()} ~ ${ispHostname.toUpperCase()} ~ ${speedStr.toUpperCase()} ~ PING: ${pingMs !== null ? pingMs + ' MS' : 'N/A'}`;

    servers.push({
      hostname: hostname.toUpperCase(),
      ip: ip,
      port: primaryPort,
      tcpPort: tcpPort,
      udpPort: udpPort,
      ports: {
        tcp: tcpPort !== null,
        udp: udpPort !== null
      },
      info: info,
      info2: info2,
      location: {
        country: countryName,
        short: shortCountry,
        name: ispHostname || countryName
      },
      id: serverId,
      key: `${ip}:${primaryPort}`,

      // Extended rich data from VPNGate HTML
      details: {
        sessions: sessionCount,
        uptime: uptimeStr,
        cumulativeUsers: userTotalStr,
        speed: speedStr,
        pingMs: pingMs,
        transfers: transfersStr,
        loggingPolicy: loggingPolicy,
        score: score,
        operator: operator,
        ispHostname: ispHostname,
        protocols: {
          sslVpn: {
            supported: sslSupported,
            tcpPort: sslTcpPort,
            udpSupported: sslUdpSupported
          },
          l2tp: {
            supported: l2tpSupported
          },
          openVpn: {
            supported: openVpnSupported,
            tcpPort: ovTcpPort,
            udpPort: ovUdpPort,
            configUrl: openVpnConfigUrl
          },
          sstp: {
            supported: sstpSupported,
            hostname: sstpHostname,
            port: sstpPort
          }
        }
      }
    });
  }

  return servers;
}

module.exports = {
  parseVpnGateHtml,
  stripHtml
};
