require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

// Make sure these model files exist in ./models/message and ./models/memory
const Message = require('./models/message');
const Memory = require('./models/memory');

// dynamic import for fetch (works in many Node versions)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// dynamic import for franc-min (language detection)
let franc = () => 'eng';
import('franc-min')
  .then(m => { franc = m.franc; })
  .catch(() => { console.warn('franc-min not found, defaulting to eng'); franc = () => 'eng'; });

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- Cache for weather/location/time to reduce repeated API calls ---
const locationCache = new Map(); // key = "lat,lon", value = { weatherText, timezone, city, lastUpdated }

// --- Helper: get weather + timezone + city ---
async function getWeatherTimeCity(lat, lon) {
  const key = `${lat},${lon}`;
  const now = Date.now();
  // return cached if <5 mins old
  if (locationCache.has(key)) {
    const cached = locationCache.get(key);
    if (now - cached.lastUpdated < 5 * 60 * 1000) return cached;
  }

  try {
    // weather/time using open-meteo (free)
    const weatherResp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`);
    const weatherData = await weatherResp.json();
    const { temperature, weathercode } = weatherData.current_weather || {};
    const weatherMap = { 0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',61:'Rain',80:'Showers' };
    const weatherText = temperature !== undefined ? `Temp: ${temperature}°C, ${weatherMap[weathercode] || 'Unknown'}` : '';

    // city via reverse geocoding (Nominatim)
    const geoResp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
    const geoData = await geoResp.json();
    const city = geoData.address?.city || geoData.address?.town || geoData.address?.state || 'Unknown';

    const timezone = weatherData.timezone || 'UTC';

    const result = { weatherText, timezone, city, lastUpdated: now };
    locationCache.set(key, result);
    return result;
  } catch(e) {
    console.error('getWeatherTimeCity error', e);
    return { weatherText: '', timezone: 'UTC', city: 'Unknown', lastUpdated: now };
  }
}

// --- franc to speech locale
function francToSpeechLang(code) {
  const map = { eng:'en-US', hin:'hi-IN', tam:'ta-IN', tel:'te-IN', kn:'kn-IN', fra:'fr-FR', spa:'es-ES' };
  return map[code] || 'en-US';
}

// --- ROUTES ---
app.get('/', async (req,res) => {
  try {
    const messages = await Message.find().sort({ createdAt: 1 }).lean();
    res.render('index', { messages });
  } catch(e) {
    console.error('GET / error', e);
    res.render('index', { messages: [] });
  }
});

app.post('/new-chat', async (req,res) => {
  try {
    await Message.deleteMany({});
    await Memory.deleteMany({});
    res.json({ success: true });
  } catch(e) {
    console.error('POST /new-chat error', e);
    res.status(500).json({ error: 'Server error while clearing chat' });
  }
});

// --- SSE streaming endpoint ---
app.post('/stream', async (req,res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.flushHeaders?.();

  const { prompt: userText, location, langOverride } = req.body;
  if (!userText?.trim()) {
    res.write(`data: ${JSON.stringify({ error: 'Empty prompt' })}\n\n`);
    return res.end();
  }

  try {
    const trimmed = userText.trim();

    // Language detection
    let langCode = 'eng';
    try {
      langCode = franc(trimmed, { minLength: 3, only: ['eng','hin','tam','tel','kn','fra','spa'] }) || 'eng';
    } catch(e) {
      langCode = 'eng';
    }
    if (langOverride && langOverride !== 'auto') langCode = langOverride.split('-')[0];
    const speechLang = francToSpeechLang(langCode);

    // Save user message
    await Message.create({ text: trimmed, role: 'user', language: langCode, createdAt: new Date() });

    // Build context for model (last 5 messages)
    const prevMessages = await Message.find().sort({ createdAt: -1 }).limit(5).lean();
    const context = prevMessages.reverse().map(m => `${m.role}: ${m.text}`).join('\n');
    const memories = await Memory.find().lean();
    const memoryContext = memories.map(m => `${m.key}: ${m.value}`).join(', ');

    // weather/time/city info
    let weatherText = '', timezone = 'UTC', city = 'Unknown';
    if (location?.lat && location?.lon) {
      const locData = await getWeatherTimeCity(location.lat, location.lon);
      weatherText = locData.weatherText;
      timezone = locData.timezone;
      city = locData.city;
    }

    const now = new Date();
    const localTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(now);
    const localDate = new Intl.DateTimeFormat('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone }).format(now);

    const systemPrompt = `You are a helpful farmer assistant. The user is speaking ${langCode}. You MUST reply in the same language.
Current context:
- User's previous messages: ${context}
- Remembered facts: ${memoryContext}
- Current Date/Time in user's location (${city}): ${localDate}, ${localTime}.
- Current Weather: ${weatherText || 'Not requested'}`;

    // Ollama settings
    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
    // DEFAULT MODEL: use the exact model name shown by `ollama list`. Example: 'llama2:7b-chat'
    const model = process.env.OLLAMA_MODEL || 'llama2:7b-chat';

    const requestUrl = `${ollamaHost}/api/generate`;
    console.log('OLLAMA requestUrl=', requestUrl);
    console.log('OLLAMA model=', model);

    // Build payload
    const payload = {
      model,
      prompt: `System: ${systemPrompt}\nUser: ${trimmed}\nAssistant:`,
      stream: true
    };

    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // improved error reporting
    if (!response.ok) {
      const text = await response.text().catch(() => '<no-body>');
      throw new Error(`Ollama API error: ${response.status} ${response.statusText} - ${text}`);
    }

    // stream parsing: robust to JSON chunks split across TCP packets
    const decoder = new TextDecoder();
    let buffer = '';
    let fullReply = '';

    // --- speech buffering for early TTS (emit sentence_partial every N words) ---
    let speechBuffer = '';
    const WORDS_THRESHOLD = 8; // change to 9 if you prefer ~9 words

    for await (const chunk of response.body) {
      const chunkText = decoder.decode(chunk, { stream: true });
      buffer += chunkText;

      // split on newline. Keep last item in buffer if incomplete.
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop(); // last chunk may be partial
      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        try {
          // Ollama sends newline-delimited JSON per chunk
          const parsed = JSON.parse(line);
          if (parsed.response) {
            // send SSE token event (as before)
            res.write(`data: ${JSON.stringify({ token: parsed.response, language: speechLang })}\n\n`);
            // append to fullReply
            fullReply += parsed.response;

            // --- accumulate for speech partials ---
            speechBuffer += parsed.response;
            // normalize whitespace and split into words
            const words = speechBuffer.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

            // emit chunks of WORDS_THRESHOLD words
            while (words.length >= WORDS_THRESHOLD) {
              const chunkWords = words.splice(0, WORDS_THRESHOLD);
              const sentenceChunk = chunkWords.join(' ');
              // remove emitted words from speechBuffer
              speechBuffer = words.join(' ');
              // emit sentence_partial SSE so client can speak this chunk immediately
              try { res.write(`data: ${JSON.stringify({ sentence_partial: sentenceChunk, language: speechLang })}\n\n`); } catch (e) {}
            }
          }
          if (parsed.done) {
            // flush any remaining speechBuffer as a final partial before done
            const leftover = (speechBuffer || '').trim();
            if (leftover) {
              try { res.write(`data: ${JSON.stringify({ sentence_partial: leftover, language: speechLang })}\n\n`); } catch(e) {}
              speechBuffer = '';
            }

            // save assistant message and close stream
            await Message.create({ text: fullReply, role: 'assistant', language: langCode, createdAt: new Date() });
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            return res.end();
          }
        } catch (e) {
          // If JSON.parse fails for a line, log and continue (might be transient)
          console.warn('Failed to parse line from Ollama stream:', line, e);
        }
      }
    }

    // if stream ends without done=true, flush remainder (token-level)
    if (buffer) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.response) {
          res.write(`data: ${JSON.stringify({ token: parsed.response, language: speechLang })}\n\n`);
          fullReply += parsed.response;

          // also consider it for speechBuffer
          speechBuffer += parsed.response;
        }
        if (parsed.done) {
          // nothing special here, done will be handled below
        }
      } catch (e) {
        // ignore
      }
    }

    // flush any remaining speechBuffer at end-of-stream
    const leftover = (speechBuffer || '').trim();
    if (leftover) {
      try { res.write(`data: ${JSON.stringify({ sentence_partial: leftover, language: speechLang })}\n\n`); } catch(e) {}
      speechBuffer = '';
    }

    // fallback end - save assistant message if we have it
    if (fullReply) {
      await Message.create({ text: fullReply, role: 'assistant', language: langCode, createdAt: new Date() });
    }
    res.end();

  } catch(err) {
    console.error('/stream error', err);
    res.write(`data: ${JSON.stringify({ error: err.message || 'Unknown error' })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚜 Server running at http://localhost:${PORT}`));
