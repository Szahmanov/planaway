const fetch = require('node-fetch');

const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
// gemma2-9b-it: 15,000 TPM free tier — highest on Groq free plan
const MODEL = 'gemma2-9b-it';

/* ─── WEATHER ────────────────────────────────── */

function weatherWindow(s, e) {
  const today = new Date(); today.setHours(0,0,0,0);
  const start = new Date(s), end = new Date(e);
  if (isNaN(start) || isNaN(end)) return null;
  const maxAhead = new Date(today); maxAhead.setDate(today.getDate() + 15);
  if (end < today)      return { ok: false, reason: 'past' };
  if (start > maxAhead) return { ok: false, reason: 'too_far' };
  const cs = start < today ? today : start;
  const ce = end > maxAhead ? maxAhead : end;
  const fmt = d => d.toISOString().slice(0,10);
  return { ok: true, start: fmt(cs), end: fmt(ce) };
}

function wDesc(c) {
  if (c===0) return 'Clear sky';   if (c<=3)  return 'Partly cloudy';
  if (c<=48) return 'Fog';         if (c<=67) return 'Rain';
  if (c<=77) return 'Snow';        if (c<=82) return 'Showers';
  return 'Storm';
}
const isGood = c => c <= 3;

async function getWeather(destination, startDate, endDate) {
  const win = weatherWindow(startDate, endDate);
  if (!win || !win.ok) return { ok: false, reason: win ? win.reason : 'bad_dates' };
  try {
    const city = destination.split(',')[0].trim();
    const geo = await fetch(
      'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=en&format=json'
    ).then(r => r.json());
    if (!geo.results || !geo.results.length) return { ok: false, reason: 'no_location' };
    const { latitude, longitude, name, country } = geo.results[0];
    const w = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=' + latitude + '&longitude=' + longitude +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode' +
      '&timezone=auto&start_date=' + win.start + '&end_date=' + win.end
    ).then(r => r.json());
    if (!w.daily || !w.daily.time) return { ok: false, reason: 'no_data' };
    const days = w.daily.time.map(function(date, i) {
      return {
        date: date,
        hi: Math.round(w.daily.temperature_2m_max[i]),
        lo: Math.round(w.daily.temperature_2m_min[i]),
        rain: w.daily.precipitation_sum[i],
        code: w.daily.weathercode[i],
        desc: wDesc(w.daily.weathercode[i]),
        good: isGood(w.daily.weathercode[i])
      };
    });
    const goodDays = days.filter(function(d){ return d.good; }).map(function(d){ return d.date; });
    const badDays  = days.filter(function(d){ return !d.good; }).map(function(d){ return d.date; });
    var summary = 'Live weather for ' + name + ', ' + country + ':\n';
    days.forEach(function(d) {
      summary += '- ' + d.date + ': ' + d.desc + ', ' + d.lo + '-' + d.hi + 'C';
      if (d.rain > 1) summary += ', ' + d.rain + 'mm rain';
      summary += '\n';
    });
    summary += 'Good days (outdoor): ' + (goodDays.join(', ') || 'none') + '\n';
    summary += 'Rainy days (indoor): ' + (badDays.join(', ') || 'none') + '\n';
    return { ok: true, location: name + ', ' + country, summary: summary, board: days };
  } catch(e) {
    console.error('Weather error:', e.message);
    return { ok: false, reason: 'error' };
  }
}

/* ─── TAVILY (called directly, results injected into prompt) ─ */

async function searchWeb(query) {
  if (!TAVILY_API_KEY) return '[web search unavailable]';
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TAVILY_API_KEY },
      body: JSON.stringify({ query: query, search_depth: 'basic', include_answer: true, max_results: 3 })
    });
    if (!r.ok) return '[search failed ' + r.status + ']';
    const data = await r.json();
    const snippets = (data.results || []).slice(0,3)
      .map(function(x){ return '- ' + x.title + ': ' + (x.content || '').slice(0, 180); })
      .join('\n');
    var out = '';
    if (data.answer) out += 'Summary: ' + data.answer.slice(0, 250) + '\n\n';
    out += snippets;
    return out;
  } catch(e) {
    return '[search error]';
  }
}

/* ─── BOOKING LINKS ──────────────────────────── */

function buildLinks(t) {
  if (!t.destination) return null;
  var dest   = encodeURIComponent(t.destination);
  var adults = t.groupSize || 2;
  var ci     = t.arrivalDate   || '';
  var co     = t.departureDate || '';
  return {
    booking: 'https://www.booking.com/searchresults.html?ss=' + dest + '&checkin=' + ci + '&checkout=' + co + '&group_adults=' + adults,
    airbnb:  'https://www.airbnb.com/s/' + dest + '/homes?checkin=' + ci + '&checkout=' + co + '&adults=' + adults,
    cars:    'https://www.rentalcars.com/SearchResults.do?country=' + dest + '&depdate=' + ci + '&retdate=' + co + '&pax=' + adults,
    maps:    'https://www.google.com/maps/search/things+to+do+in+' + dest
  };
}

/* ─── HANDLER ────────────────────────────────── */

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!GROQ_API_KEY)   return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not set on server.' }) };
  if (!TAVILY_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'TAVILY_API_KEY not set on server.' }) };

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  var tripData            = body.tripData || {};
  var conversationHistory = body.conversationHistory || [];
  if (!conversationHistory.length) return { statusCode: 400, body: JSON.stringify({ error: 'No messages' }) };

  try {
    // 1. Weather — free, parallel fetch
    var weather = { ok: false };
    if (tripData.destination && tripData.arrivalDate && tripData.departureDate) {
      weather = await getWeather(tripData.destination, tripData.arrivalDate, tripData.departureDate);
    }

    // 2. Tavily searches run BEFORE Groq, results injected into prompt
    var searchResults = '';
    var searchesUsed  = 0;
    var dest = tripData.destination;
    var lastUserMsg = '';
    for (var i = conversationHistory.length - 1; i >= 0; i--) {
      if (conversationHistory[i].role === 'user') { lastUserMsg = conversationHistory[i].content || ''; break; }
    }

    if (dest && lastUserMsg.length > 8) {
      var results = await Promise.all([
        searchWeb('top things to do ' + dest + ' ' + new Date().getFullYear()),
        searchWeb('best local restaurants food ' + dest)
      ]);
      searchResults = 'WEB SEARCH RESULTS (cite specific places from these):\n\nAttractions:\n' + results[0] + '\n\nFood & restaurants:\n' + results[1];
      searchesUsed = 2;
    }

    var links = buildLinks(tripData);

    // 3. Compact system prompt
    var weatherCtx = '';
    if (weather.ok) {
      weatherCtx = weather.summary;
    } else if (weather.reason === 'too_far') {
      weatherCtx = 'Trip is >16 days away, no live forecast. Describe typical seasonal weather for ' + (tripData.destination || 'the destination') + ' during those dates.';
    } else if (weather.reason === 'past') {
      weatherCtx = 'Those dates are in the past.';
    }

    var bookingLinks = links
      ? 'Hotels: ' + links.booking + '\nAirbnb: ' + links.airbnb + '\nCars: ' + links.cars + '\nMap: ' + links.maps
      : 'Provide destination to generate links.';

    var systemPrompt = 'You are PlanAway, an autonomous AI travel planning agent.\n\n' +
      'RULES:\n' +
      '- Ask max 2 short questions if key info is missing. Key info: destination, dates, group (adults/kids+ages), interests, budget, visited before, transport.\n' +
      '- Once you have enough: build a FULL day-by-day itinerary. Do not keep asking questions.\n' +
      '- Use the web search results below for SPECIFIC named places.\n' +
      '- Outdoor activities on good-weather days, indoor on rainy days.\n' +
      '- For families: label what kids love vs adults each day.\n' +
      '- End with booking links.\n' +
      '- Reply in the SAME language the user writes in.\n' +
      '- Format: ## Day 1 — City, **Place Name**, bullet lists.\n\n' +
      'WEATHER:\n' + (weatherCtx || 'Need destination + dates.') + '\n\n' +
      (searchResults ? searchResults + '\n\n' : '') +
      'BOOKING LINKS:\n' + bookingLinks + '\n\n' +
      'TRIP INFO: ' + JSON.stringify(tripData);

    // 4. Single Groq call — no agentic loop, stays within TPM limits
    var groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API_KEY },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1800,
        temperature: 0.7,
        messages: [{ role: 'system', content: systemPrompt }].concat(conversationHistory)
      })
    });

    if (!groqRes.ok) {
      var err = await groqRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Groq API error ' + groqRes.status + ': ' + err.slice(0,300) }) };
    }

    var groqData = await groqRes.json();
    var text = (groqData.choices && groqData.choices[0] && groqData.choices[0].message && groqData.choices[0].message.content) || 'No response. Please try again.';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, searchesUsed: searchesUsed, weather: weather.ok ? { location: weather.location, board: weather.board } : null, links: links, ok: true })
    };

  } catch(err) {
    console.error('Handler error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
