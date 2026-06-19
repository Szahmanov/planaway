const fetch = require('node-fetch');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// gemini-2.0-flash: 1,000,000 TPM free tier — no rate limit issues
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=';

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

/* ─── TAVILY SEARCH ──────────────────────────── */

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
      .map(function(x){ return '- ' + x.title + ': ' + (x.content || '').slice(0, 200); })
      .join('\n');
    var out = '';
    if (data.answer) out += 'Summary: ' + data.answer.slice(0, 300) + '\n\n';
    out += snippets;
    return out;
  } catch(e) {
    return '[search error: ' + e.message + ']';
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
  if (!GEMINI_API_KEY)  return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY not set on server.' }) };
  if (!TAVILY_API_KEY)  return { statusCode: 500, body: JSON.stringify({ error: 'TAVILY_API_KEY not set on server.' }) };

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  var tripData            = body.tripData || {};
  var conversationHistory = body.conversationHistory || [];
  if (!conversationHistory.length) return { statusCode: 400, body: JSON.stringify({ error: 'No messages' }) };

  try {
    // 1. Weather + web search run in parallel before the LLM call
    var weatherPromise = (tripData.destination && tripData.arrivalDate && tripData.departureDate)
      ? getWeather(tripData.destination, tripData.arrivalDate, tripData.departureDate)
      : Promise.resolve({ ok: false });

    var dest = tripData.destination;
    var lastUserMsg = '';
    for (var i = conversationHistory.length - 1; i >= 0; i--) {
      if (conversationHistory[i].role === 'user') { lastUserMsg = conversationHistory[i].content || ''; break; }
    }

    var searchPromise = (dest && lastUserMsg.length > 8)
      ? Promise.all([
          searchWeb('top things to do attractions ' + dest + ' ' + new Date().getFullYear()),
          searchWeb('best local restaurants food ' + dest)
        ])
      : Promise.resolve(null);

    var results = await Promise.all([weatherPromise, searchPromise]);
    var weather       = results[0];
    var searchResults = results[1];
    var searchesUsed  = searchResults ? 2 : 0;

    var links = buildLinks(tripData);

    // 2. Build system prompt
    var weatherCtx = '';
    if (weather.ok) {
      weatherCtx = weather.summary;
    } else if (weather.reason === 'too_far') {
      weatherCtx = 'Trip is more than 16 days away — no live forecast available yet. Describe typical seasonal weather for ' + (tripData.destination || 'the destination') + ' during those dates instead.';
    } else if (weather.reason === 'past') {
      weatherCtx = 'Those dates are in the past.';
    }

    var searchCtx = '';
    if (searchResults) {
      searchCtx = 'WEB SEARCH RESULTS (use specific named places from these in your plan):\n\nAttractions & things to do:\n' + searchResults[0] + '\n\nFood & restaurants:\n' + searchResults[1] + '\n\n';
    }

    var bookingCtx = links
      ? 'Hotels: ' + links.booking + '\nAirbnb: ' + links.airbnb + '\nCars: ' + links.cars + '\nMap: ' + links.maps
      : 'Provide destination to generate links.';

    var systemPrompt = 'You are PlanAway, an autonomous AI travel planning agent. You create complete, highly personalized day-by-day travel itineraries.\n\n' +
      'PROCESS:\n' +
      '1. If missing key facts, ask maximum 2 short questions. Key facts needed: destination, exact dates, who is travelling (adults/kids+ages), interests & pace, budget level, visited before?, transport preference (rental car vs taxi/transit), accommodation type.\n' +
      '2. Once you have enough information: BUILD the full day-by-day itinerary immediately. Do not keep asking.\n' +
      '3. Use the web search results below for SPECIFIC real named places — never generic advice.\n' +
      '4. Schedule outdoor activities on good-weather days, indoor activities (museums, galleries, aquariums, markets, cooking classes) on rainy days. Explain why each day is arranged that way.\n' +
      '5. For families with children: label what kids will love AND include something for adults each day.\n' +
      '6. If they have visited before: focus on NEW experiences.\n' +
      '7. End the plan with concrete next steps and the booking links below.\n\n' +
      'WEATHER DATA:\n' + (weatherCtx || 'Need destination + both dates to generate forecast.') + '\n\n' +
      searchCtx +
      'BOOKING LINKS (embed as markdown links in your response):\n' + bookingCtx + '\n\n' +
      'TRIP CONTEXT: ' + JSON.stringify(tripData) + '\n\n' +
      'STYLE: Warm and specific, never generic. Write like a sharp local friend. Use ## Day 1 headers, **bold place names**, bullet lists, [text](url) links. Include time of day, rough costs, travel time between stops. Reply in the SAME language the user writes in.';

    // 3. Build Gemini conversation format
    // Gemini uses "parts" not "content" and roles are "user"/"model" (not "assistant")
    var geminiHistory = [];
    for (var j = 0; j < conversationHistory.length - 1; j++) {
      var msg = conversationHistory[j];
      geminiHistory.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    }
    // Last user message
    var lastMsg = conversationHistory[conversationHistory.length - 1];

    var geminiBody = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: geminiHistory.concat([{
        role: 'user',
        parts: [{ text: lastMsg.content }]
      }]),
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7
      }
    };

    // 4. Call Gemini
    var geminiRes = await fetch(GEMINI_URL + GEMINI_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    if (!geminiRes.ok) {
      var err = await geminiRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Gemini API error ' + geminiRes.status + ': ' + err.slice(0, 400) }) };
    }

    var geminiData = await geminiRes.json();
    var text = '';
    try {
      text = geminiData.candidates[0].content.parts[0].text || '';
    } catch(e) {
      console.error('Gemini parse error:', JSON.stringify(geminiData).slice(0,300));
      text = 'Sorry, could not generate a response. Please try again.';
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        searchesUsed: searchesUsed,
        weather: weather.ok ? { location: weather.location, board: weather.board } : null,
        links: links,
        ok: true
      })
    };

  } catch(err) {
    console.error('Handler error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
