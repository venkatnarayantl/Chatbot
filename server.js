const express = require('express');
const mongoose = require('mongoose');
const Message = require('./models/message');
const Memory = require('./models/memory');  // Add this line

const { spawn } = require('child_process');
const franc = require('franc-min').default;
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(()=>console.log('✅ Connected to MongoDB'))
  .catch(err=>console.error(err));

// Home page
app.get('/', async (req,res)=>{
  const messages = await Message.find().sort({createdAt:1});
  res.render('index',{messages});
});

// New chat
app.post('/new-chat', async (req,res)=>{
  try{
    await Message.deleteMany({});
    res.json({success:true});
  }catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

// Weather & time
async function getWeatherAndTime(lat, lon){
  try{
    const fetch = (...args) => import('node-fetch').then(m=>m.default);
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
    const data = await resp.json();
    const temp = data.current_weather.temperature;
    const code = data.current_weather.weathercode;
    const map = {
      0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',
      45:'Fog',48:'Rime fog',51:'Drizzle light',53:'Drizzle moderate',
      55:'Drizzle dense',61:'Rain slight',63:'Rain moderate',65:'Rain heavy',
      71:'Snow slight',73:'Snow moderate',75:'Snow heavy',
      80:'Rain showers slight',81:'Rain showers moderate',82:'Rain showers violent'
    };
    const climate = map[code]||'Unknown';
    const time = data.current_weather.time;
    return `Temperature: ${temp}°C, Climate: ${climate}, Local time: ${time}`;
  }catch(e){ return ''; }
}

// Map franc code to speech
function francToSpeechLang(code){
  const map={eng:'en-US',hin:'hi-IN',tam:'ta-IN',tel:'te-IN',fra:'fr-FR',spa:'es-ES'};
  return map[code]||'en-US';
}

// Run Ollama
async function runOllama(prompt){
  return new Promise((resolve,reject)=>{
    const child = spawn('ollama',['run','llama3']);
    let output='';
    let errorOutput='';
    child.stdout.on('data',data=>output+=data.toString());
    child.stderr.on('data',data=>errorOutput+=data.toString());
    child.on('close',()=>resolve(output.trim()||"Sorry, I couldn't generate a reply."));
    child.on('error',err=>reject(err));
    child.stdin.write(prompt+'\n');
    child.stdin.end();
  });
}

// Handle messages
// Handle messages
app.post('/message', async (req, res) => {
  try {
    const { text, role, location } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Empty text' });

    const trimmed = text.trim();

    // --- Save user message ---
    const userMsg = new Message({
      text: trimmed,
      role: role || 'user',
      language: 'auto',
      createdAt: new Date()
    });
    await userMsg.save();

    // --- Check for memory updates ---
    // Simple example: "My name is Venkat"
    const nameMatch = trimmed.match(/my name is (\w+)/i);
    if(nameMatch){
      const name = nameMatch[1];
      await Memory.findOneAndUpdate(
        { key: 'name' },
        { value: name, createdAt: new Date() },
        { upsert: true }
      );
    }

    // Retrieve stored memories
    const memories = await Memory.find().lean();
    let memoryContext = '';
    memories.forEach(m => {
      memoryContext += `${m.key}: ${m.value} | `;
    });

    // --- Last 5 messages context ---
    const prev = await Message.find().sort({ createdAt: 1 }).lean();
    const last5 = prev.slice(-5);
    const context = last5.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join(' | ');

    // --- Weather & local time ---
    let weatherInfo = '';
    if (location?.lat && location?.lon) weatherInfo = await getWeatherAndTime(location.lat, location.lon);

    // --- Current date/time ---
    const now = new Date();
    const dateStr = now.toLocaleDateString();
    const timeStr = now.toLocaleTimeString();

    // --- Build prompt ---
    let prompt = `${context} | ${memoryContext} User: ${trimmed} | Assistant (reply in same language)`;
    prompt += ` | Current date: ${dateStr}, Current time: ${timeStr}`;
    if(weatherInfo) prompt += ` | Weather info: ${weatherInfo}`;

    // --- Run Ollama ---
    const reply = await runOllama(prompt);

    // --- Save assistant reply ---
    const assistantMsg = new Message({
      text: reply,
      role: 'assistant',
      language: 'auto',
      createdAt: new Date()
    });
    await assistantMsg.save();

    res.json({
      reply,
      date: dateStr,
      time: timeStr,
      weather: weatherInfo
    });

  } catch (err) {
    console.error('POST /message error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


const PORT = process.env.PORT||5000;
app.listen(PORT,()=>console.log(`🚜 Server running at http://localhost:${PORT}`));
