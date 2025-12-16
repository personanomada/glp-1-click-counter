import { useState, useRef, useEffect, useCallback } from 'react'

// Dosing data for GLP-1 pens
const PEN_DATA = {
  wegovy: {
    name: 'Wegovy',
    pens: [
      { label: '0.5mg (1.5mL)', totalClicks: 148, mgPerClick: 0.0134 },
      { label: '1.0mg (3mL)', totalClicks: 74, mgPerClick: 0.0135 },
      { label: '1.7mg (3mL)', totalClicks: 75, mgPerClick: 0.0227 },
      { label: '2.4mg (3mL)', totalClicks: 75, mgPerClick: 0.032 },
    ],
    doses: [0.25, 0.5, 1.0, 1.7, 2.0, 2.4],
  },
  ozempic: {
    name: 'Ozempic',
    pens: [
      { label: '1mg (3mL)', totalClicks: 72, mgPerClick: 0.0139 },
      { label: '2mg (3mL)', totalClicks: 74, mgPerClick: 0.027 },
    ],
    doses: [0.25, 0.5, 0.75, 1.0, 1.5, 2.0],
  },
}

const STORAGE_KEY = 'glp1-dose-history'

function App() {
  // State
  const [medication, setMedication] = useState('wegovy')
  const [penIndex, setPenIndex] = useState(0)
  const [targetDose, setTargetDose] = useState(0.25)
  const [customDose, setCustomDose] = useState('')
  const [sensitivity, setSensitivity] = useState(0.15)
  const [clickCount, setClickCount] = useState(0)
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState([])
  const [targetReached, setTargetReached] = useState(false)
  const [micPermission, setMicPermission] = useState(null) // null = unknown, 'granted', 'denied', 'prompt'

  // Refs for audio processing
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const streamRef = useRef(null)
  const animationFrameRef = useRef(null)
  const previousVolumeRef = useRef(0)
  const lastClickTimeRef = useRef(0)

  // Derived values
  const currentPen = PEN_DATA[medication].pens[penIndex]
  const currentDose = clickCount * currentPen.mgPerClick
  const targetClicks = Math.round(targetDose / currentPen.mgPerClick)
  const progress = targetClicks > 0 ? Math.min((clickCount / targetClicks) * 100, 100) : 0

  // Load history from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        setHistory(JSON.parse(saved))
      }
    } catch (e) {
      console.error('Failed to load history:', e)
    }
  }, [])

  // Check if target reached
  useEffect(() => {
    setTargetReached(clickCount >= targetClicks && targetClicks > 0)
  }, [clickCount, targetClicks])

  // Reset pen index when medication changes
  useEffect(() => {
    setPenIndex(0)
  }, [medication])

  // Check microphone permission status on mount
  useEffect(() => {
    const checkMicPermission = async () => {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const result = await navigator.permissions.query({ name: 'microphone' })
          setMicPermission(result.state)
          result.onchange = () => setMicPermission(result.state)
        } else {
          // Browser doesn't support permission query - set to 'prompt' so user can request
          setMicPermission('prompt')
        }
      } catch (e) {
        // Some browsers don't support permission query for microphone (e.g., Safari)
        // Set to 'prompt' so the button still works
        console.log('Permission query not supported, defaulting to prompt')
        setMicPermission('prompt')
      }
    }
    checkMicPermission()
  }, [])

  // Check if we're in a secure context (HTTPS or localhost)
  const isSecureContext = window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'

  // Request microphone permission
  const requestMicPermission = async () => {
    setError(null)

    // Check for secure context first
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicPermission('denied')
      if (!isSecureContext) {
        setError('Microphone requires HTTPS. On mobile, use localhost or enable HTTPS. On iOS Safari, this may not work over local network without HTTPS.')
      } else {
        setError('Microphone not supported in this browser.')
      }
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Stop the stream immediately - we just wanted to trigger the permission prompt
      stream.getTracks().forEach(track => track.stop())
      setMicPermission('granted')
    } catch (err) {
      console.error('Microphone permission error:', err)
      setMicPermission('denied')
      setError('Microphone access denied. Please allow microphone access in your browser settings.')
    }
  }

  // Audio processing loop
  const processAudio = useCallback(() => {
    if (!analyserRef.current) return

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
    analyserRef.current.getByteFrequencyData(dataArray)

    // Calculate current volume (RMS-like)
    let sum = 0
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i]
    }
    const currentVolume = sum / dataArray.length / 255

    // Smoothed previous volume
    const smoothedPrevious = previousVolumeRef.current

    // Calculate spike
    const spike = currentVolume - smoothedPrevious

    // Check for click
    const now = Date.now()
    const timeSinceLastClick = now - lastClickTimeRef.current

    if (spike > sensitivity && timeSinceLastClick > 150) {
      setClickCount(prev => prev + 1)
      lastClickTimeRef.current = now
    }

    // Update smoothed previous (0.3 current + 0.7 previous)
    previousVolumeRef.current = 0.3 * currentVolume + 0.7 * smoothedPrevious

    animationFrameRef.current = requestAnimationFrame(processAudio)
  }, [sensitivity])

  // Start listening
  const startListening = async () => {
    setError(null)
    setClickCount(0)
    setTargetReached(false)
    previousVolumeRef.current = 0
    lastClickTimeRef.current = 0

    // Check for secure context first
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (!isSecureContext) {
        setError('Microphone requires HTTPS. On mobile, use localhost or enable HTTPS. On iOS Safari, this may not work over local network without HTTPS.')
      } else {
        setError('Microphone not supported in this browser.')
      }
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
      analyserRef.current = analyser

      setIsListening(true)
      animationFrameRef.current = requestAnimationFrame(processAudio)
    } catch (err) {
      console.error('Microphone error:', err)
      setError('Microphone access denied. Please allow microphone access to use click detection.')
    }
  }

  // Stop listening
  const stopListening = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
    }
    setIsListening(false)
  }

  // Save dose to history
  const saveDose = () => {
    const entry = {
      id: Date.now(),
      date: new Date().toISOString(),
      medication: PEN_DATA[medication].name,
      penStrength: currentPen.label,
      clicks: clickCount,
      dose: currentDose,
      targetDose: targetDose,
    }

    const newHistory = [entry, ...history]
    setHistory(newHistory)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory))
    stopListening()
    setClickCount(0)
  }

  // Clear history
  const clearHistory = () => {
    if (window.confirm('Are you sure you want to clear all dose history?')) {
      setHistory([])
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  // Manual click adjustment
  const adjustClicks = (delta) => {
    setClickCount(prev => Math.max(0, prev + delta))
  }

  // Handle quick dose selection
  const selectDose = (dose) => {
    setTargetDose(dose)
    setCustomDose('')
  }

  // Handle custom dose input
  const handleCustomDose = (e) => {
    const value = e.target.value
    setCustomDose(value)
    const parsed = parseFloat(value)
    if (!isNaN(parsed) && parsed > 0) {
      setTargetDose(parsed)
    }
  }

  // Format date for display
  const formatDate = (isoString) => {
    const date = new Date(isoString)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4">
      <div className="max-w-md mx-auto space-y-4">
        {/* Header */}
        <header className="text-center py-4">
          <h1 className="text-2xl font-bold text-cyan-400">GLP-1 Click Counter</h1>
          <p className="text-slate-400 text-sm">Track your injection pen clicks</p>
        </header>

        {/* Medication Selection */}
        <div className="bg-slate-800 rounded-xl p-4">
          <label className="text-slate-400 text-sm block mb-2">Medication</label>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(PEN_DATA).map(([key, data]) => (
              <button
                key={key}
                onClick={() => setMedication(key)}
                disabled={isListening}
                className={`py-3 rounded-lg font-medium transition-all ${
                  medication === key
                    ? 'bg-cyan-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                } ${isListening ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {data.name}
              </button>
            ))}
          </div>
        </div>

        {/* Pen Selection */}
        <div className="bg-slate-800 rounded-xl p-4">
          <label className="text-slate-400 text-sm block mb-2">Pen Strength</label>
          <div className="grid grid-cols-2 gap-2">
            {PEN_DATA[medication].pens.map((pen, idx) => (
              <button
                key={idx}
                onClick={() => setPenIndex(idx)}
                disabled={isListening}
                className={`py-3 px-2 rounded-lg text-sm font-medium transition-all ${
                  penIndex === idx
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                } ${isListening ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {pen.label}
              </button>
            ))}
          </div>
          <p className="text-slate-500 text-xs mt-2">
            {currentPen.totalClicks} total clicks, {currentPen.mgPerClick.toFixed(4)} mg/click
          </p>
        </div>

        {/* Target Dose Selection */}
        <div className="bg-slate-800 rounded-xl p-4">
          <label className="text-slate-400 text-sm block mb-2">Target Dose (mg)</label>
          <div className="flex flex-wrap gap-2 mb-3">
            {PEN_DATA[medication].doses.map(dose => (
              <button
                key={dose}
                onClick={() => selectDose(dose)}
                disabled={isListening}
                className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                  targetDose === dose && customDose === ''
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                } ${isListening ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {dose}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-sm">Custom:</span>
            <input
              type="number"
              step="0.05"
              min="0.05"
              value={customDose}
              onChange={handleCustomDose}
              disabled={isListening}
              placeholder="Enter dose"
              className={`flex-1 bg-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 ${
                isListening ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            />
          </div>
          <p className="text-slate-500 text-xs mt-2">
            Target: {targetClicks} clicks for {targetDose.toFixed(2)} mg
          </p>
        </div>

        {/* Sensitivity Slider */}
        <div className="bg-slate-800 rounded-xl p-4">
          <label className="text-slate-400 text-sm block mb-2">
            Detection Sensitivity: {sensitivity.toFixed(2)}
          </label>
          <input
            type="range"
            min="0.05"
            max="0.4"
            step="0.01"
            value={sensitivity}
            onChange={(e) => setSensitivity(parseFloat(e.target.value))}
            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />
          <div className="flex justify-between text-slate-500 text-xs mt-1">
            <span>More sensitive</span>
            <span>Less sensitive</span>
          </div>
        </div>

        {/* Main Counter Display */}
        <div className={`rounded-xl p-6 text-center transition-all ${
          targetReached ? 'bg-emerald-900' : 'bg-slate-800'
        }`}>
          {targetReached && (
            <div className="text-emerald-400 text-lg font-medium mb-2">
              <span className="mr-2">&#x2713;</span>
              Target dose reached!
            </div>
          )}
          <div className="text-6xl font-bold text-white mb-2">{clickCount}</div>
          <div className="text-slate-400 text-lg mb-4">
            {currentDose.toFixed(2)} mg
          </div>
          <div className="w-full bg-slate-700 rounded-full h-3 mb-2">
            <div
              className={`h-3 rounded-full transition-all ${
                targetReached ? 'bg-emerald-500' : 'bg-cyan-500'
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="text-slate-500 text-sm">
            {clickCount} / {targetClicks} clicks to target
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-xl p-4 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Microphone Permission Button */}
        {micPermission !== 'granted' && !isListening && (
          <button
            onClick={requestMicPermission}
            className="w-full bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium py-3 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
            </svg>
            {micPermission === 'denied' ? 'Microphone Blocked - Check Settings' : 'Request Microphone Access'}
          </button>
        )}

        {micPermission === 'granted' && !isListening && (
          <div className="flex items-center justify-center gap-2 text-emerald-400 text-sm">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Microphone access granted
          </div>
        )}

        {/* Control Buttons */}
        <div className="flex gap-2">
          {!isListening ? (
            <button
              onClick={startListening}
              className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white font-medium py-4 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
              </svg>
              Start Listening
            </button>
          ) : (
            <>
              <button
                onClick={stopListening}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white font-medium py-4 rounded-xl transition-all"
              >
                Stop
              </button>
              <button
                onClick={saveDose}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-4 rounded-xl transition-all"
              >
                Save Dose
              </button>
            </>
          )}
        </div>

        {/* Manual Adjustment Buttons */}
        {isListening && (
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => adjustClicks(-1)}
              className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 px-6 rounded-xl transition-all text-xl"
            >
              -
            </button>
            <span className="py-3 px-4 text-slate-400">Manual adjust</span>
            <button
              onClick={() => adjustClicks(1)}
              className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 px-6 rounded-xl transition-all text-xl"
            >
              +
            </button>
          </div>
        )}

        {/* History Toggle */}
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium py-3 rounded-xl transition-all"
        >
          {showHistory ? 'Hide' : 'Show'} Dose History ({history.length})
        </button>

        {/* History List */}
        {showHistory && (
          <div className="bg-slate-800 rounded-xl p-4 space-y-3">
            {history.length > 0 ? (
              <>
                <div className="max-h-64 overflow-y-auto space-y-2">
                  {history.map(entry => (
                    <div key={entry.id} className="bg-slate-700 rounded-lg p-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="text-white font-medium">{entry.medication}</div>
                          <div className="text-slate-400 text-sm">{entry.penStrength}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-cyan-400 font-medium">{entry.dose.toFixed(2)} mg</div>
                          <div className="text-slate-500 text-xs">{entry.clicks} clicks</div>
                        </div>
                      </div>
                      <div className="text-slate-500 text-xs mt-1">{formatDate(entry.date)}</div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={clearHistory}
                  className="w-full bg-red-900/50 hover:bg-red-900 text-red-300 text-sm py-2 rounded-lg transition-all"
                >
                  Clear History
                </button>
              </>
            ) : (
              <p className="text-slate-500 text-center text-sm">No doses recorded yet</p>
            )}
          </div>
        )}

        {/* Disclaimer */}
        <p className="text-slate-500 text-xs text-center px-4 pb-4">
          This tool is for informational purposes only. Click-counting is not officially recommended by manufacturers. Always follow your healthcare provider's instructions.
        </p>
      </div>
    </div>
  )
}

export default App
