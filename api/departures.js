// Vercel Serverless Function: api/departures.js
// Proxies Munich Public Transit (MVG) live departures without browser CORS restrictions.

module.exports = async function handler(req, res) {
  // CORS headers allowing browser frontend access from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const query = req.query.query;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  if (!query && (lat === null || lng === null)) {
    return res.status(400).json({ 
      error: 'Missing query or coordinates. Usage: /api/departures?query=Marienplatz' 
    });
  }

  // Exact aliases for station name variations to ensure 100% resolution in MVG's API
  const ALIASES = {
    'karlsplatz': 'Karlsplatz (Stachus)',
    'stachus': 'Karlsplatz (Stachus)',
    'karlsplatz (stachus)': 'Karlsplatz (Stachus)',
    'hauptbahnhof': 'Hauptbahnhof',
    'hbf': 'Hauptbahnhof',
    'münchen hbf': 'Hauptbahnhof',
    'münchen-pasing': 'Pasing',
    'pasing': 'Pasing',
    'münchen-laim': 'Laim',
    'laim': 'Laim',
    'thalkirchen (tierpark)': 'Thalkirchen (Tierpark)',
    'thalkirchen': 'Thalkirchen (Tierpark)',
    'großhesselohe isartalbf': 'Großhesselohe Isartalbahnhof',
    'furth (b deisenhofen)': 'Furth',
    'deisenhofen': 'Deisenhofen',
    'oez': 'Olympia-Einkaufszentrum',
    'olympia-einkaufszentrum': 'Olympia-Einkaufszentrum'
  };

  try {
    let targetQuery = (query || '').trim();
    const lower = targetQuery.toLowerCase();
    
    if (ALIASES[lower]) {
      targetQuery = ALIASES[lower];
    } else {
      // Remove leading München prefixes
      targetQuery = targetQuery.replace(/^München[-\s]+/i, '').trim();
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Munich-Zone-M-Transit-App)'
    };

    let locations = [];

    // 1. Textual search query to MVG Location API
    const locationUrl = `https://www.mvg.de/api/bgw-pt/v3/locations?query=${encodeURIComponent(targetQuery)}`;
    const locRes = await fetch(locationUrl, { headers });
    if (locRes.ok) {
      locations = await locRes.json();
    }

    // 2. Fallback without parentheses if initial lookup returned 0 results
    if ((!locations || locations.length === 0) && /\(/.test(targetQuery)) {
      const stripped = targetQuery.replace(/\s*\(.*?\)/g, '').trim();
      const fallbackRes = await fetch(`https://www.mvg.de/api/bgw-pt/v3/locations?query=${encodeURIComponent(stripped)}`, { headers });
      if (fallbackRes.ok) {
        locations = await fallbackRes.json();
      }
    }

    // 3. Fallback to nearby coordinates if available
    if ((!locations || locations.length === 0) && lat !== null && lng !== null) {
      const coordRes = await fetch(`https://www.mvg.de/api/bgw-pt/v3/locations/nearby?latitude=${lat}&longitude=${lng}`, { headers });
      if (coordRes.ok) {
        locations = await coordRes.json();
      }
    }

    if (!locations || locations.length === 0) {
      return res.status(404).json({ error: `Station "${query}" not found in MVG network` });
    }

    // In Munich, Hauptbahnhof is split into distinct station entities in MVG's API:
    // de:09162:6 = U-Bahn hub (U1, U2, U4, U5, U7, U8) & Tram
    // de:09162:100 = S-Bahn hub (S1, S2, S3, S4, S6, S7, S8) & DB regional/long-distance rail
    const isHbf = /hauptbahnhof|hbf/i.test(targetQuery);
    let targetStationIds = [];

    if (isHbf) {
      // Query both platforms concurrently to retrieve all U-Bahn and S-Bahn departures
      targetStationIds = ['de:09162:6', 'de:09162:100'];
    } else {
      // For other interchange stations, check if separate U and S entities exist in the location results
      const uLoc = locations.find(loc => (loc.type === 'STATION' || loc.type === 'STOP') && loc.transportTypes && loc.transportTypes.includes('UBAHN'));
      const sLoc = locations.find(loc => (loc.type === 'STATION' || loc.type === 'STOP') && loc.transportTypes && loc.transportTypes.includes('SBAHN'));

      if (uLoc && sLoc && (uLoc.globalId || uLoc.id) !== (sLoc.globalId || sLoc.id)) {
        targetStationIds = [uLoc.globalId || uLoc.id, sLoc.globalId || sLoc.id];
      } else {
        const primary = locations.find(loc => loc.type === 'STATION') || 
                        locations.find(loc => loc.type === 'STOP') || 
                        locations[0];
        const primaryId = primary.globalId || primary.id;
        if (primaryId) targetStationIds = [primaryId];
      }
    }

    if (targetStationIds.length === 0) {
      return res.status(404).json({ error: `Station ID could not be determined for "${query}"` });
    }

    const departurePromises = targetStationIds.map(id => {
      const depUrl = `https://www.mvg.de/api/bgw-pt/v3/departures?globalId=${encodeURIComponent(id)}&limit=36&transportTypes=UBAHN,SBAHN`;
      return fetch(depUrl, { headers })
        .then(r => r.ok ? r.json() : [])
        .then(data => Array.isArray(data) ? data : [])
        .catch(err => {
          console.warn(`Fetch failed for globalId ${id}:`, err.message);
          return [];
        });
    });

    const departureBatches = await Promise.all(departurePromises);
    const rawDepartures = departureBatches.flat();
    const now = Date.now();
    const seenDepartures = new Set();

    const departures = rawDepartures
      .filter(d => {
        if (d.cancelled === true) return false;
        const type = (d.transportType || d.product || '').toUpperCase();
        const label = (d.label || d.lineNumber || '').toUpperCase().replace(/\s+/g, '');
        return type === 'UBAHN' || type === 'SBAHN' || label.startsWith('U') || label.startsWith('S');
      })
      .map(d => {
        const planned = d.plannedDepartureTime || d.departureTime || now;
        const actual = d.realtimeDepartureTime || planned;
        const diffMins = Math.max(0, Math.round((actual - now) / 60000));
        const delayMins = d.delayInMinutes != null 
          ? d.delayInMinutes 
          : Math.max(0, Math.round((actual - planned) / 60000));

        let dest = d.destination || 'Zentrum';
        if (dest.startsWith('München ')) {
          dest = dest.substring(8);
        }

        return {
          line: (d.label || d.lineNumber || '').replace(/\s+/g, ''),
          direction: dest,
          minsUntil: diffMins,
          scheduledTime: new Date(planned),
          delay: delayMins,
          platform: d.platform || null,
          realtime: d.realtime !== false
        };
      })
      .filter(d => {
        if (!d.line || d.line.length === 0) return false;
        // Deduplicate identical departures if both stations reported the trip
        const key = `${d.line}|${d.direction}|${d.scheduledTime.getTime()}`;
        if (seenDepartures.has(key)) return false;
        seenDepartures.add(key);
        return true;
      })
      .sort((a, b) => a.minsUntil - b.minsUntil)
      .slice(0, 32);

    // Edge cache for 15 seconds to ensure fast response times
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    return res.status(200).json(departures);

  } catch (error) {
    console.error('Departures API Error:', error.message);
    return res.status(502).json({ 
      error: 'Failed to fetch live departures from transport provider',
      details: error.message 
    });
  }
};