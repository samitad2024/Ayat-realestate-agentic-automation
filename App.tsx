import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { MOCK_PROPERTIES, SYSTEM_INSTRUCTION } from './constants';
import { createPcmBlob, base64ToUint8Array, decodeAudioData } from './services/audioUtils';
import LiveVisualizer from './components/LiveVisualizer';
import { Message, ConnectionState, Property } from './types';

// Voice Config: 'Kore' is typically a good female voice option
const VOICE_NAME = 'Kore';
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

const App: React.FC = () => {
  // State
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [activeProperty, setActiveProperty] = useState<Property | null>(null);

  // Refs for Audio management
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sessionRef = useRef<any>(null); // To store the session object directly if needed for closure scope
  const sessionPromiseRef = useRef<Promise<any> | null>(null);

  // Visualization State helpers
  const [audioSource, setAudioSource] = useState<'none' | 'user' | 'model'>('none');

  // Initialize Audio Contexts
  const ensureAudioContexts = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      // Setup Analyser for visualization
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
    }
    if (!inputAudioContextRef.current) {
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    }
  };

  const connectToGemini = async () => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      ensureAudioContexts();

      // Resume contexts if suspended (browser autoplay policy)
      if (audioContextRef.current?.state === 'suspended') await audioContextRef.current.resume();
      if (inputAudioContextRef.current?.state === 'suspended') await inputAudioContextRef.current.resume();

      // Get Mic Stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Initialize GenAI Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      const config = {
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {}, // Fixed: Must be empty object to enable
          outputAudioTranscription: {}, // Fixed: Must be empty object to enable
        },
      };

      // Connect
      const sessionPromise = ai.live.connect({
        ...config,
        callbacks: {
          onopen: () => {
            console.log("Connection Opened");
            setConnectionState(ConnectionState.CONNECTED);
            startAudioInputStream(stream, sessionPromise);
          },
          onmessage: (msg: LiveServerMessage) => handleServerMessage(msg),
          onclose: () => {
            console.log("Connection Closed");
            setConnectionState(ConnectionState.DISCONNECTED);
          },
          onerror: (err) => {
            console.error("Connection Error", err);
            setConnectionState(ConnectionState.ERROR);
          },
        },
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (error) {
      console.error("Failed to connect:", error);
      setConnectionState(ConnectionState.ERROR);
    }
  };

  const startAudioInputStream = (stream: MediaStream, sessionPromise: Promise<any>) => {
    if (!inputAudioContextRef.current) return;

    const source = inputAudioContextRef.current.createMediaStreamSource(stream);
    // Use a ScriptProcessor to extract raw PCM data (workaround for AudioWorklet complexity in single file)
    const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (isMicMuted) return; // Don't send data if muted

      const inputData = e.inputBuffer.getChannelData(0);
      
      // Basic VAD visualization trigger
      const rms = Math.sqrt(inputData.reduce((sum, val) => sum + val * val, 0) / inputData.length);
      if (rms > 0.01) setAudioSource('user');
      else if (audioSource === 'user') setAudioSource('none');

      const pcmBlob = createPcmBlob(inputData);
      
      sessionPromise.then((session) => {
        session.sendRealtimeInput({ media: pcmBlob });
      });
    };

    source.connect(processor);
    processor.connect(inputAudioContextRef.current.destination);
  };

  const handleServerMessage = async (message: LiveServerMessage) => {
    const { serverContent } = message;

    // Handle Transcriptions
    if (serverContent?.outputTranscription?.text) {
      const text = serverContent.outputTranscription.text;
      setMessages((prev) => {
        // If the last message is from the model, append to it (simple streaming logic)
        const lastMsg = prev[prev.length - 1];
        if (lastMsg && lastMsg.role === 'model' && lastMsg.isPartial) {
          return [
             ...prev.slice(0, -1),
             { ...lastMsg, text: lastMsg.text + text } // Naive append, ideally handle turnComplete
          ];
        }
         // Otherwise new message
        return [...prev, { id: Date.now().toString(), role: 'model', text, timestamp: new Date(), isPartial: true }];
      });
    }

    if (serverContent?.inputTranscription?.text) {
        const text = serverContent.inputTranscription.text;
        // User transcriptions usually come in chunks too, but often final. 
        // For simplicity in this demo, we add them. Real apps need more sophisticated merging.
         setMessages((prev) => {
             const lastMsg = prev[prev.length - 1];
             if(lastMsg && lastMsg.role === 'user' && lastMsg.isPartial) {
                 return [...prev.slice(0, -1), { ...lastMsg, text: lastMsg.text + text }];
             }
             return [...prev, { id: Date.now().toString(), role: 'user', text, timestamp: new Date(), isPartial: true }];
         });
    }

    if (serverContent?.turnComplete) {
        setMessages(prev => prev.map(m => ({ ...m, isPartial: false })));
        setAudioSource('none');
    }

    // Handle Audio Output
    const base64Audio = serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (base64Audio && audioContextRef.current && analyserRef.current) {
      setAudioSource('model');
      try {
        const audioBytes = base64ToUint8Array(base64Audio);
        // Sync timing
        nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContextRef.current.currentTime);
        
        const audioBuffer = await decodeAudioData(audioBytes, audioContextRef.current);
        
        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        
        // Connect to analyser for visualization and then to destination
        source.connect(analyserRef.current);
        analyserRef.current.connect(audioContextRef.current.destination);
        
        source.start(nextStartTimeRef.current);
        nextStartTimeRef.current += audioBuffer.duration;
        
        sourcesRef.current.add(source);
        
        source.onended = () => {
          sourcesRef.current.delete(source);
          if (sourcesRef.current.size === 0) {
             setAudioSource('none');
          }
        };

      } catch (e) {
        console.error("Audio decode error", e);
      }
    }
    
    // Check interruption
    if (serverContent?.interrupted) {
        console.log("Model interrupted");
        sourcesRef.current.forEach(s => s.stop());
        sourcesRef.current.clear();
        nextStartTimeRef.current = 0;
        setAudioSource('none');
    }
  };

  const disconnect = () => {
    // There isn't a direct .close() on the session object exposed easily in the pattern
    // Usually we just stop sending and close the context, or if the library supported it.
    // For now, reload or just stop streams.
    
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
    }
    if (inputAudioContextRef.current) {
        inputAudioContextRef.current.close();
        inputAudioContextRef.current = null;
    }
    setConnectionState(ConnectionState.DISCONNECTED);
    setMessages(prev => [...prev, {id: 'sys', role: 'model', text: 'Call ended.', timestamp: new Date()}]);
  };

  // Auto-scroll chat
  const chatContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="flex flex-col h-full bg-slate-100">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-600 rounded-full flex items-center justify-center text-white font-bold text-xl">
            A
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight">Ayat Real Estate</h1>
            <p className="text-xs text-slate-500 font-medium tracking-wide uppercase">AI Sales Assistant</p>
          </div>
        </div>
        <div className={`px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-2 ${
            connectionState === ConnectionState.CONNECTED ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
        }`}>
            <span className={`w-2 h-2 rounded-full ${connectionState === ConnectionState.CONNECTED ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`}></span>
            {connectionState === ConnectionState.CONNECTED ? 'LIVE' : connectionState}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex flex-col md:flex-row relative">
        
        {/* Left Panel: Visualizer & Active Call UI */}
        <div className="flex-1 flex flex-col p-4 md:p-6 gap-6 justify-center items-center bg-gradient-to-b from-slate-50 to-slate-100">
            
            {/* Visualizer Container */}
            <div className="w-full max-w-md aspect-video bg-white rounded-2xl shadow-lg border border-slate-100 overflow-hidden relative">
                <div className="absolute top-4 left-4 z-10 flex gap-2">
                     <span className="text-xs font-bold text-slate-400 px-2 py-1 bg-slate-50 rounded border border-slate-100">
                        Agent: Tigist
                     </span>
                </div>
                
                {/* Visualizer */}
                <div className="w-full h-full flex items-center justify-center bg-slate-50/50">
                    <LiveVisualizer 
                        analyser={analyserRef.current} 
                        isListening={audioSource === 'user'} 
                        isSpeaking={audioSource === 'model'}
                    />
                </div>
                
                {/* Overlay Status Text */}
                <div className="absolute bottom-4 left-0 w-full text-center">
                     <p className="text-sm font-medium text-slate-500 transition-opacity duration-300 amharic-text">
                        {audioSource === 'model' ? 'እየተናገርኩ ነው... (Speaking)' : audioSource === 'user' ? 'እየሰማሁ ነው... (Listening)' : 'ዝግጁ (Ready)'}
                     </p>
                </div>
            </div>

            {/* Property Highlight (Mock Context) */}
            <div className="w-full max-w-md">
                <h3 className="text-xs font-bold text-slate-400 uppercase mb-2 tracking-wider">Featured Properties</h3>
                <div className="grid grid-cols-1 gap-3">
                    {MOCK_PROPERTIES.slice(0, 1).map(p => (
                        <div key={p.id} className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex justify-between items-center">
                            <div>
                                <h4 className="font-semibold text-slate-800">{p.title}</h4>
                                <p className="text-sm text-slate-500">{p.location}</p>
                                <p className="text-xs text-emerald-600 font-bold mt-1">{p.price}</p>
                            </div>
                            <div className="h-10 w-10 bg-slate-100 rounded-lg flex items-center justify-center text-slate-400">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                                </svg>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>

        {/* Right Panel: Transcript */}
        <div className="h-1/3 md:h-full md:w-96 bg-white border-l border-slate-200 flex flex-col shadow-xl z-20">
            <div className="p-4 border-b border-slate-100 bg-slate-50/50">
                <h2 className="text-sm font-semibold text-slate-700">Live Transcript</h2>
            </div>
            <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 && (
                    <div className="text-center mt-10 opacity-50">
                        <p className="text-sm text-slate-400 mb-2">Start a call to speak with Tigist.</p>
                        <p className="text-xs text-slate-300 amharic-text">ለመጀመር ይደውሉ</p>
                    </div>
                )}
                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] rounded-2xl p-3 text-sm leading-relaxed ${
                            msg.role === 'user' 
                            ? 'bg-slate-100 text-slate-800 rounded-tr-none' 
                            : 'bg-emerald-50 text-emerald-900 rounded-tl-none border border-emerald-100'
                        }`}>
                            <p className="amharic-text">{msg.text}</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
      </main>

      {/* Footer Controls */}
      <footer className="bg-white border-t border-slate-200 p-6 flex justify-center items-center gap-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-30">
        
        {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
             <button 
                onClick={connectToGemini}
                className="group relative flex items-center justify-center gap-3 bg-emerald-600 hover:bg-emerald-700 text-white px-8 py-4 rounded-full font-semibold transition-all shadow-lg hover:shadow-emerald-200 hover:-translate-y-0.5"
             >
                <div className="absolute inset-0 rounded-full border border-white/20"></div>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                <span>Call Sales Agent</span>
            </button>
        ) : (
            <>
                <button 
                    onClick={() => setIsMicMuted(!isMicMuted)}
                    className={`p-4 rounded-full transition-all border ${isMicMuted ? 'bg-red-50 border-red-200 text-red-500' : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'}`}
                >
                    {isMicMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
                        </svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        </svg>
                    )}
                </button>
                
                <button 
                    onClick={disconnect}
                    className="p-4 rounded-full bg-red-100 text-red-600 hover:bg-red-200 transition-all border border-red-200"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.516l2.257-1.13a1 1 0 00.502-1.21l-1.498-4.493a1 1 0 00-.949-.684H5z" />
                    </svg>
                </button>
            </>
        )}
      </footer>
    </div>
  );
};

export default App;