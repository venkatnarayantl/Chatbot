const express = require('express');
const mongoose = require('mongoose');
const Message = require('./models/message');
const Memory = require('./models/memory'); // memory model
const { spawn } = require('child_process');
require('dotenv').config();

// ---------- Safe franc loader ----------
let franc;
try {
  franc = require('franc-min');
  if (franc && typeof franc !== 'function' && franc.default && typeof franc.default === 'function') {
    franc = franc.default;
  }
} catch (e) {
  franc = null;
}
if (!franc || typeof franc !== 'function') {
  console.warn('franc not available — falling back to English-only detection stub');
  franc = () => 'eng';
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(()=>console.log('✅ Connected to MongoDB'))
  .catch(err=>console.error('❌ MongoDB connection error:',err));

// Get weather and time from Open-Meteo
async function getWeatherAndTime(lat, lon){
  try{
    const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data || !data.current_weather) return { text:'', timezone:'UTC', localTimeFromApi:null };

    const temp = data.current_weather.temperature;
    const code = data.current_weather.weathercode;
    const timezone = data.timezone || 'UTC';
    const localTimeFromApi = data.current_weather.time;

    const map = {
      0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',
      45:'Fog',48:'Rime fog',51:'Drizzle light',53:'Drizzle moderate',
      55:'Drizzle dense',61:'Rain slight',63:'Rain moderate',65:'Rain heavy',
      71:'Snow slight',73:'Snow moderate',75:'Snow heavy',
      80:'Rain showers slight',81:'Rain showers moderate',82:'Rain showers violent'
    };
    const climate = map[code] || 'Unknown';
    const text = `Temperature: ${temp}°C, Climate: ${climate}, Local time (API): ${localTimeFromApi || 'N/A'}`;
    return { text, timezone, localTimeFromApi };
  }catch(e){
    console.error('getWeatherAndTime error', e);
    return { text:'', timezone:'UTC', localTimeFromApi:null };
  }
}

// Map franc code to speechSynthesis locale
function francToSpeechLang(code){
  const map={
    eng:'en-US',
    hin:'hi-IN',
    tam:'ta-IN',
    tel:'te-IN',
    kn:'kn-IN', // Kannada added
    fra:'fr-FR',
    spa:'es-ES'
  };
  return map[code] || 'en-US';
}

// Run Ollama CLI
function runOllama(prompt){
  return new Promise((resolve,reject)=>{
    try{
      const child = spawn('ollama',['run','llama3'],{ stdio:['pipe','pipe','pipe'] });
      let output='', errOut='';

      child.stdout.on('data', data=> output += data.toString());
      child.stderr.on('data', data=> errOut += data.toString());

      child.on('close', ()=> resolve(output.trim() || "Sorry, I couldn't generate a reply."));
      child.on('error', err=> reject(err));

      child.stdin.write(prompt+'\n');
      child.stdin.end();
    }catch(err){ reject(err); }
  });
}

// Home page
app.get('/', async (req,res)=>{
  const messages = await Message.find().sort({createdAt:1});
  res.render('index',{messages});
});

// New chat
app.post('/new-chat', async (req,res)=>{
  try{
    await Message.deleteMany({});
    await Memory.deleteMany({});
    res.json({success:true});
  }catch(e){
    console.error('POST /new-chat error', e);
    res.status(500).json({error:'Server error'});
  }
});

// Handle messages
app.post('/message', async (req,res)=>{
  try{
    const { text, role, location } = req.body;
    if (!text?.trim()) return res.status(400).json({ error:'Empty text' });
    const trimmed = text.trim();

    // --- Detect language ---
    let langCode = franc(trimmed) || 'eng';
    if(/[\u0C80-\u0CFF]/.test(trimmed)) langCode = 'kn'; // Kannada detection

    // --- Save user message ---
    await Message.create({
      text: trimmed,
      role: role || 'user',
      language: langCode,
      createdAt: new Date()
    });

    // --- Update memory if "my name is X" ---
    const nameMatch = trimmed.match(/my name is (\w+)/i);
    if(nameMatch){
      const name = nameMatch[1];
      await Memory.findOneAndUpdate(
        { key:'name' },
        { value:name, createdAt:new Date() },
        { upsert:true }
      );
    }

    // --- Build memory context ---
    const memories = await Memory.find().lean();
    let memoryContext='';
    memories.forEach(m=> memoryContext += `${m.key}: ${m.value} | `);

    // --- Last 5 messages context ---
    const prev = await Message.find().sort({createdAt:1}).lean();
    const last5 = prev.slice(-5);
    const context = last5.map(m=>`${m.role==='user'?'User':'Assistant'}: ${m.text}`).join(' | ');

    // --- Weather & time ---
    let weatherInfo={ text:'', timezone:'UTC', localTimeFromApi:null };
    if(location && location.lat && location.lon){
      weatherInfo = await getWeatherAndTime(location.lat, location.lon);
    }

    // --- Current date/time ---
    const now = new Date();
    const tz = weatherInfo.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const optionsDate = { day:'2-digit', month:'short', year:'numeric', timeZone:tz };
    const optionsTime = { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true, timeZone:tz };
    const optionsWeekday = { weekday:'short', timeZone:tz };
    const dateStr = new Intl.DateTimeFormat('en-GB', optionsDate).format(now);
    const timeStr = new Intl.DateTimeFormat('en-US', optionsTime).format(now);
    const weekdayStr = new Intl.DateTimeFormat('en-GB', optionsWeekday).format(now);

    // --- Build Ollama prompt ---
    let prompt = `${memoryContext} ${context} | User: ${trimmed} | Assistant (reply in same language)`;
    prompt += ` | Current weekday: ${weekdayStr}, Current date: ${dateStr}, Current time: ${timeStr}`;
    if(weatherInfo.text) prompt += ` | Weather info: ${weatherInfo.text}`;

    // --- Run model ---
    const reply = await runOllama(prompt);

    // --- Save assistant reply ---
    await Message.create({
      text: reply,
      role:'assistant',
      language: langCode,
      createdAt: new Date()
    });

    res.json({
      reply,
      weekday: weekdayStr,
      date: dateStr,
      time: timeStr,
      weather: weatherInfo.text,
      language: francToSpeechLang(langCode)
    });

  }catch(err){
    console.error('POST /message error:', err);
    res.status(500).json({ error:'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, ()=>console.log(`🚜 Server running at http://localhost:${PORT}`));
