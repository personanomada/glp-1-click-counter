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
const SETTINGS_KEY = 'glp1-settings'
const SIGNATURE_KEY = 'glp1-click-signature'

// Detection modes
const DETECTION_MODES = {
  simple: {
    name: 'Simple',
    description: 'Basic volume spike detection - works for any loud click sound'
  },
  advanced: {
    name: 'Advanced',
    description: 'Uses your calibrated pen click signature for accurate detection'
  }
}

// Load click signature from localStorage
const loadSignature = () => {
  try {
    const saved = localStorage.getItem(SIGNATURE_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('Failed to load signature:', e)
  }
  return null
}

// Load saved settings from localStorage
const loadSettings = () => {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  return null
}

const savedSettings = loadSettings()

function App() {
  // State - initialize from saved settings if available
  const [medication, setMedication] = useState(savedSettings?.medication || 'wegovy')
  const [penIndex, setPenIndex] = useState(savedSettings?.penIndex || 0)
  const [targetDose, setTargetDose] = useState(savedSettings?.targetDose || 0.25)
  const [customDose, setCustomDose] = useState('')
  const [sensitivity, setSensitivity] = useState(savedSettings?.sensitivity || 0.15)
  const [clickCount, setClickCount] = useState(0)
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState([])
  const [targetReached, setTargetReached] = useState(false)
  const [micPermission, setMicPermission] = useState(null) // null = unknown, 'granted', 'denied', 'prompt'
  const [detectionMode, setDetectionMode] = useState(savedSettings?.detectionMode || 'simple') // 'simple' or 'advanced'

  // Calibration state
  const [isCalibrating, setIsCalibrating] = useState(false)
  const [calibrationClicks, setCalibrationClicks] = useState([])
  const [clickSignature, setClickSignature] = useState(loadSignature)
  const calibrationSamplesRef = useRef([])

  // Refs for audio processing
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const streamRef = useRef(null)
  const animationFrameRef = useRef(null)
  const previousVolumeRef = useRef(0)
  const lastClickTimeRef = useRef(0)

  // Additional refs for advanced detection
  const highPassFilterRef = useRef(null)
  const previousHighFreqVolumeRef = useRef(0)
  const volumeHistoryRef = useRef([]) // For transient detection
  const peakHoldRef = useRef(0)
  const decayCounterRef = useRef(0)
  const lowFreqHistoryRef = useRef([]) // Track low frequency (voice) energy
  const baselineNoiseRef = useRef(0) // Adaptive noise floor

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

  // Save settings to localStorage when they change
  useEffect(() => {
    const settings = {
      medication,
      penIndex,
      targetDose,
      sensitivity,
      detectionMode
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [medication, penIndex, targetDose, sensitivity, detectionMode])

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

    // Debug info
    console.log('Secure context:', window.isSecureContext)
    console.log('mediaDevices available:', !!navigator.mediaDevices)
    console.log('getUserMedia available:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia))

    // Check for secure context first
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicPermission('denied')
      if (!isSecureContext) {
        setError('Microphone requires HTTPS. On mobile, use localhost or enable HTTPS. On iOS Safari, this may not work over local network without HTTPS.')
      } else {
        setError('Microphone not supported in this browser. Check console for details.')
      }
      return
    }

    try {
      console.log('Requesting microphone access...')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      console.log('Microphone access granted!')
      // Stop the stream immediately - we just wanted to trigger the permission prompt
      stream.getTracks().forEach(track => track.stop())
      setMicPermission('granted')
    } catch (err) {
      console.error('Microphone permission error:', err.name, err.message)
      setMicPermission('denied')
      if (err.name === 'NotAllowedError') {
        setError('Microphone access denied. Please click the camera icon in Chrome\'s address bar to allow access.')
      } else if (err.name === 'NotFoundError') {
        setError('No microphone found. Please connect a microphone and try again.')
      } else {
        setError(`Microphone error: ${err.name} - ${err.message}`)
      }
    }
  }

  // Simple detection - original algorithm
  const processAudioSimple = useCallback(() => {
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

    animationFrameRef.current = requestAnimationFrame(processAudioSimple)
  }, [sensitivity])

  // Get frequency profile from current audio data
  const getFrequencyProfile = useCallback((dataArray) => {
    // Divide spectrum into 8 bands for signature matching
    const bandCount = 8
    const bandSize = Math.floor(dataArray.length / bandCount)
    const bands = []

    for (let b = 0; b < bandCount; b++) {
      let sum = 0
      for (let i = b * bandSize; i < (b + 1) * bandSize; i++) {
        sum += dataArray[i]
      }
      bands.push(sum / bandSize / 255)
    }

    return bands
  }, [])

  // Calculate similarity between two frequency profiles (0-1, higher is more similar)
  const calculateSimilarity = useCallback((profile1, profile2) => {
    if (!profile1 || !profile2 || profile1.length !== profile2.length) return 0

    let dotProduct = 0
    let norm1 = 0
    let norm2 = 0

    for (let i = 0; i < profile1.length; i++) {
      dotProduct += profile1[i] * profile2[i]
      norm1 += profile1[i] * profile1[i]
      norm2 += profile2[i] * profile2[i]
    }

    if (norm1 === 0 || norm2 === 0) return 0
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2))
  }, [])

  // Calibration audio processing
  const processCalibration = useCallback(() => {
    if (!analyserRef.current) return

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
    analyserRef.current.getByteFrequencyData(dataArray)

    // Calculate overall energy
    let sum = 0
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i]
    }
    const energy = sum / dataArray.length / 255

    const smoothedPrevious = previousVolumeRef.current
    const spike = energy - smoothedPrevious

    const now = Date.now()
    const timeSinceLastClick = now - lastClickTimeRef.current

    // Detect a spike during calibration
    if (spike > 0.08 && timeSinceLastClick > 200) {
      const profile = getFrequencyProfile(dataArray)
      calibrationSamplesRef.current.push({
        profile,
        energy,
        timestamp: now
      })
      setCalibrationClicks(prev => [...prev, { time: now, energy }])
      lastClickTimeRef.current = now
    }

    previousVolumeRef.current = 0.3 * energy + 0.7 * smoothedPrevious
    animationFrameRef.current = requestAnimationFrame(processCalibration)
  }, [getFrequencyProfile])

  // Advanced detection - uses calibrated signature
  const processAudioAdvanced = useCallback(() => {
    if (!analyserRef.current) return

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
    analyserRef.current.getByteFrequencyData(dataArray)

    // Calculate overall energy
    let sum = 0
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i]
    }
    const energy = sum / dataArray.length / 255

    const smoothedPrevious = previousHighFreqVolumeRef.current
    const spike = energy - smoothedPrevious

    const now = Date.now()
    const timeSinceLastClick = now - lastClickTimeRef.current

    // If we have a signature, use it for matching
    if (clickSignature && spike > sensitivity * 0.5) {
      const currentProfile = getFrequencyProfile(dataArray)
      const similarity = calculateSimilarity(currentProfile, clickSignature.profile)

      // High similarity to signature = likely a pen click
      if (similarity > 0.85 && spike > sensitivity * 0.3 && timeSinceLastClick > 150) {
        setClickCount(prev => prev + 1)
        lastClickTimeRef.current = now
      }
    } else {
      // Fallback to basic high-frequency detection if no signature
      const midPoint = Math.floor(dataArray.length / 2)
      let highSum = 0
      let lowSum = 0

      for (let i = 0; i < midPoint; i++) {
        lowSum += dataArray[i]
      }
      for (let i = midPoint; i < dataArray.length; i++) {
        highSum += dataArray[i]
      }

      const highEnergy = highSum / (dataArray.length - midPoint) / 255
      const lowEnergy = lowSum / midPoint / 255
      const isLikelyVoice = lowEnergy > highEnergy * 1.5 && lowEnergy > 0.1

      if (spike > sensitivity && !isLikelyVoice && timeSinceLastClick > 150) {
        setClickCount(prev => prev + 1)
        lastClickTimeRef.current = now
      }
    }

    previousHighFreqVolumeRef.current = 0.3 * energy + 0.7 * smoothedPrevious
    animationFrameRef.current = requestAnimationFrame(processAudioAdvanced)
  }, [sensitivity, clickSignature, getFrequencyProfile, calculateSimilarity])

  // Main audio processing dispatcher
  const processAudio = useCallback(() => {
    if (detectionMode === 'advanced') {
      processAudioAdvanced()
    } else {
      processAudioSimple()
    }
  }, [detectionMode, processAudioSimple, processAudioAdvanced])

  // Start listening
  const startListening = async () => {
    setError(null)
    setClickCount(0)
    setTargetReached(false)

    // Reset simple detection refs
    previousVolumeRef.current = 0
    lastClickTimeRef.current = 0

    // Reset advanced detection refs
    previousHighFreqVolumeRef.current = 0
    volumeHistoryRef.current = []
    peakHoldRef.current = 0
    decayCounterRef.current = 0
    lowFreqHistoryRef.current = []
    baselineNoiseRef.current = 0

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

      // Use larger FFT for better frequency resolution in advanced mode
      analyser.fftSize = detectionMode === 'advanced' ? 512 : 256
      analyser.smoothingTimeConstant = detectionMode === 'advanced' ? 0.1 : 0.3

      source.connect(analyser)
      analyserRef.current = analyser

      setIsListening(true)

      // Start the appropriate processing loop directly
      if (detectionMode === 'advanced') {
        animationFrameRef.current = requestAnimationFrame(processAudioAdvanced)
      } else {
        animationFrameRef.current = requestAnimationFrame(processAudioSimple)
      }
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

  // Start calibration
  const startCalibration = async () => {
    setError(null)
    setCalibrationClicks([])
    calibrationSamplesRef.current = []
    previousVolumeRef.current = 0
    lastClickTimeRef.current = 0

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Microphone not available')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.1

      source.connect(analyser)
      analyserRef.current = analyser

      setIsCalibrating(true)
      animationFrameRef.current = requestAnimationFrame(processCalibration)
    } catch (err) {
      console.error('Calibration error:', err)
      setError('Failed to start calibration')
    }
  }

  // Finish calibration and save signature
  const finishCalibration = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
    }

    const samples = calibrationSamplesRef.current
    if (samples.length >= 3) {
      // Average the frequency profiles
      const avgProfile = samples[0].profile.map((_, i) => {
        const sum = samples.reduce((acc, s) => acc + s.profile[i], 0)
        return sum / samples.length
      })

      const avgEnergy = samples.reduce((acc, s) => acc + s.energy, 0) / samples.length

      const signature = {
        profile: avgProfile,
        avgEnergy,
        sampleCount: samples.length,
        createdAt: new Date().toISOString()
      }

      setClickSignature(signature)
      localStorage.setItem(SIGNATURE_KEY, JSON.stringify(signature))
    }

    setIsCalibrating(false)
    setCalibrationClicks([])
    calibrationSamplesRef.current = []
  }

  // Cancel calibration
  const cancelCalibration = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
    }
    setIsCalibrating(false)
    setCalibrationClicks([])
    calibrationSamplesRef.current = []
  }

  // Clear saved signature
  const clearSignature = () => {
    if (window.confirm('Clear your saved pen click signature?')) {
      setClickSignature(null)
      localStorage.removeItem(SIGNATURE_KEY)
    }
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

  // Reset click count (without stopping listening)
  const resetCount = () => {
    setClickCount(0)
    setTargetReached(false)
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

        {/* Calibration Modal */}
        {isCalibrating && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
            <div className="bg-slate-800 rounded-xl p-6 max-w-sm w-full space-y-4">
              <h2 className="text-xl font-bold text-cyan-400 text-center">Calibrate Your Pen</h2>
              <p className="text-slate-300 text-sm text-center">
                Click your pen 5 times. Hold the pen close to your device's microphone.
              </p>

              {/* Click indicators */}
              <div className="flex justify-center gap-2">
                {[0, 1, 2, 3, 4].map(i => (
                  <div
                    key={i}
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                      i < calibrationClicks.length
                        ? 'bg-emerald-500 text-white'
                        : 'bg-slate-700 text-slate-500'
                    }`}
                  >
                    {i < calibrationClicks.length ? '\u2713' : i + 1}
                  </div>
                ))}
              </div>

              <p className="text-slate-400 text-center text-lg">
                {calibrationClicks.length} / 5 clicks recorded
              </p>

              <div className="flex gap-2">
                <button
                  onClick={cancelCalibration}
                  className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-3 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={finishCalibration}
                  disabled={calibrationClicks.length < 3}
                  className={`flex-1 py-3 rounded-lg font-medium ${
                    calibrationClicks.length >= 3
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  Save ({calibrationClicks.length >= 3 ? 'Ready' : 'Need 3+'})
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Detection Mode Selection */}
        <div className="bg-slate-800 rounded-xl p-4">
          <label className="text-slate-400 text-sm block mb-2">Detection Mode</label>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(DETECTION_MODES).map(([key, mode]) => (
              <button
                key={key}
                onClick={() => setDetectionMode(key)}
                disabled={isListening}
                className={`py-3 px-2 rounded-lg text-sm font-medium transition-all ${
                  detectionMode === key
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                } ${isListening ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {mode.name}
              </button>
            ))}
          </div>
          <p className="text-slate-500 text-xs mt-2">
            {DETECTION_MODES[detectionMode].description}
          </p>

          {/* Calibration controls for Advanced mode */}
          {detectionMode === 'advanced' && !isListening && (
            <div className="mt-3 pt-3 border-t border-slate-700">
              {clickSignature ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-emerald-400 text-sm flex items-center gap-1">
                      <span>\u2713</span> Signature saved ({clickSignature.sampleCount} samples)
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={startCalibration}
                      className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm py-2 rounded-lg"
                    >
                      Recalibrate
                    </button>
                    <button
                      onClick={clearSignature}
                      className="bg-red-900/50 hover:bg-red-900 text-red-300 text-sm py-2 px-3 rounded-lg"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-amber-400 text-sm">No signature yet - calibrate for best accuracy</p>
                  <button
                    onClick={startCalibration}
                    className="w-full bg-amber-600 hover:bg-amber-500 text-white font-medium py-2 rounded-lg"
                  >
                    Calibrate Pen Click
                  </button>
                </div>
              )}
            </div>
          )}
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

        {/* Manual Adjustment and Reset Buttons */}
        {isListening && (
          <div className="space-y-2">
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
            <button
              onClick={resetCount}
              className="w-full bg-amber-700 hover:bg-amber-600 text-white font-medium py-2 rounded-xl transition-all text-sm"
            >
              Reset Count to 0
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
