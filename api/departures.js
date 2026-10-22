// Vercel Serverless Function: api/departures.js
// Proxies Munich Public Transit (MVG) live departures using GPS-first lookups for expanded zones.

module.exports = async function handler(req, res) {
  // CORS headers allowing browser frontend access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const query = req.query.query || '';
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  if (!query && (lat === null || lng === null)) {
    return res.status(400).json({ error: 'Missing query or coordinates.' });
  }

  // Required headers to bypass MVG Web Application Firewall (WAF)
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'X-MVG-Authorization-Key': '5af1beca494712ed38d313714d4caff6', // Official public MVG key
    'Origin': 'https://www.mvg.de',
    'Referer': 'https://www.mvg.de/'
  };

  try {
    let targetStationIds = new Set();

    // STEP 1: Coordinate-based Search (Crucial for expanded zones)
    // GPS lookups prevent API errors caused by slight naming differences outside Munich city limits.
    if (lat !== null && lng !== null) {
      const coordRes = await fetch(`https://www.mvg.de/api/bgw-pt/v3/locations/nearby?latitude=${lat}&longitude=${lng}`, { headers });
      if (coordRes.ok) {
        const locations = await coordRes.json();
        // Grab all station nodes within a 350-meter radius (captures split Hbf platforms)
        const closeStations = locations.filter(loc => 
           (loc.type === 'STATION' || loc.type === 'STOP') && loc.distance <= 350
        );
        
        closeStations.forEach(s => {
          if (s.globalId) targetStationIds.add(s.globalId);
          else if (s.id) targetStationIds.add(s.id);
        });
      }
    }

    // STEP 2: Fallback to Text Search (If GPS lookup returned nothing)
    if (targetStationIds.size === 0 && query) {
      let safeQuery = query.replace(/^München[-\s]+/i, '').trim();
      
      if (/hauptbahnhof|hbf/i.test(safeQuery)) {
        targetStationIds.add('de:09162:6');   // U-Bahn
        targetStationIds.add('de:09162:100'); // S-Bahn
      } else {
        const searchRes = await fetch(`https://www.mvg.de/api/bgw-pt/v3/locations?query=${encodeURIComponent(safeQuery)}`, { headers });
        if (searchRes.ok) {
          const locations = await searchRes.json();
          if (locations.length > 0) {
            targetStationIds.add(locations[0].globalId || locations[0].id);
          }
        }
      }
    }

    if (targetStationIds.size === 0) {
      return res.status(404).json({ error: `Station "${query}" could not be resolved in the network.` });
    }

    // STEP 3: Fetch Departures
    // We removed 'transportTypes=UBAHN,SBAHN' from the URL because in outer zones, 
    // some S-Bahns are classified differently by MVG. We will filter them manually in JS.
    const departurePromises = Array.from(targetStationIds).map(id => {
      const depUrl = `https://www.mvg.de/api/bgw-pt/v3/departures?globalId=${encodeURIComponent(id)}&limit=40`;
      return fetch(depUrl, { headers })
        .then(r => r.ok ? r.json() : [])
        .catch(err => {
          console.warn(`Fetch failed for ID ${id}:`, err.message);
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
        const label = (d.label || d.lineNumber || '').toUpperCase().replace(/\s+/g, '');
        // Keep ONLY U-Bahn and S-Bahn lines regardless of zone classification
        return label.startsWith('U') || label.startsWith('S');
      })
      .map(d => {
        const planned = d.plannedDepartureTime || d.departureTime || now;
        const actual = d.realtimeDepartureTime || planned;
        const diffMins = Math.max(0, Math.round((actual - now) / 60000));
        
        let delayMins = d.delayInMinutes;
        if (delayMins == null) {
            delayMins = Math.max(0, Math.round((actual - planned) / 60000));
        }

        let dest = d.destination || 'Zentrum';
        if (dest.startsWith('München ')) dest = dest.substring(8);

        return {
          line: (d.label || d.lineNumber || '').replace(/\s+/g, ''),
          direction: dest,
          minsUntil: diffMins,
          scheduledTime: new Date(planned),
          delay: delayMins
        };
      })
      .filter(d => {
        if (!d.line) return false;
        // Deduplicate identical train runs
        const key = `${d.line}|${d.direction}|${d.scheduledTime.getTime()}`;
        if (seenDepartures.has(key)) return false;
        seenDepartures.add(key);
        return true;
      })
      .sort((a, b) => a.minsUntil - b.minsUntil)
      .slice(0, 32);

    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
    return res.status(200).json(departures);

  } catch (error) {
    console.error('Departures API Error:', error.message);
    return res.status(502).json({ 
      error: 'Fehler beim Verbinden mit MVG (WAF oder Netzwerkfehler)',
      details: error.message 
    });
  }
};
