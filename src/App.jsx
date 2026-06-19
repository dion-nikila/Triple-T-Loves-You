import { useCallback, useEffect, useRef, useState } from 'react'
import { TungSwarm } from './components/TungSwarm.jsx'
import {
  classifyHandGesture,
  detectSwipeFromHistory,
  getPinchDistanceRatio,
  getPalmCenter,
  mapLandmarkToCover,
  smoothLandmarks,
} from './lib/handGestures.js'

const MEDIAPIPE_MODULE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm'
const MEDIAPIPE_WASM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const MIN_POINT_DISTANCE = 4
const MAX_POINT_JUMP = 110
const SUMMON_HOLD_FRAMES = 7
const SUMMON_CONFIRM_FRAMES = 2
const UNDO_HOLD_FRAMES = 8
const PINCH_HOLD_FRAMES = 3
const PINCH_RELEASE_RATIO = 0.52
const SWIPE_DISTANCE = 0.095
const SWIPE_HISTORY_DURATION = 760
const SWIPE_ARM_DURATION = 760
const SWIPE_COOLDOWN = 900
const LANDMARK_RESET_DELAY = 250
const INDEX_TRACKING_GRACE = 240
const DRAWING_START_DELAY = 220
const MAX_DESKTOP_TUNGS = 220
const MAX_COMPACT_TUNGS = 120

function getCameraConstraints(stage) {
  const width = stage?.clientWidth || window.innerWidth
  const height = stage?.clientHeight || window.innerHeight
  const isPortrait = height > width
  const isCompact = Math.min(width, height) <= 600

  return {
    facingMode: { ideal: 'user' },
    width: { ideal: isPortrait ? 480 : isCompact ? 640 : 1280 },
    height: { ideal: isPortrait ? 640 : isCompact ? 480 : 720 },
    aspectRatio: { ideal: isPortrait ? 3 / 4 : isCompact ? 4 / 3 : 16 / 9 },
    frameRate: { ideal: isCompact ? 24 : 30, max: 30 },
  }
}

function styleDrawingContext(context) {
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = 6
  context.strokeStyle = '#f5fffb'
  context.shadowColor = '#47ffd1'
  context.shadowBlur = 13
}

function drawPath(context, path, width, height) {
  if (!path.length) return

  context.beginPath()
  context.moveTo(path[0].nx * width, path[0].ny * height)

  if (path.length === 1) {
    context.lineTo(path[0].nx * width + 0.01, path[0].ny * height)
  } else {
    for (let index = 1; index < path.length; index += 1) {
      const previous = path[index - 1]
      const point = path[index]
      const midX = ((previous.nx + point.nx) / 2) * width
      const midY = ((previous.ny + point.ny) / 2) * height
      context.quadraticCurveTo(
        previous.nx * width,
        previous.ny * height,
        midX,
        midY,
      )
    }
    const last = path[path.length - 1]
    context.lineTo(last.nx * width, last.ny * height)
  }

  context.stroke()
}

function sampleSwarmPoints(paths, maximumPoints) {
  const points = paths.flat()
  if (points.length <= maximumPoints) return points

  return Array.from({ length: maximumPoints }, (_, index) =>
    points[
      Math.round(
        (index / Math.max(maximumPoints - 1, 1)) * (points.length - 1),
      )
    ],
  )
}

function createSwarm(paths, maximumPoints) {
  const points = sampleSwarmPoints(paths, maximumPoints)
  const lastIndex = Math.max(points.length - 1, 1)

  return points.map((point, index) => ({
    id: `${index}-${performance.now().toFixed(2)}`,
    x: point.nx,
    y: point.ny,
    size: Math.round(44 + Math.random() * 24),
    delay: Math.round((index / lastIndex) * 1100 + Math.random() * 70),
    rotation: Math.round(-6 + Math.random() * 12),
    duration: Math.round(680 + Math.random() * 360),
    wiggleDelay: Math.round(-Math.random() * 900),
  }))
}

export function App() {
  const stageRef = useRef(null)
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const fingerCursorRef = useRef(null)
  const pathsRef = useRef([])
  const activePathRef = useRef(null)
  const lastPointRef = useRef(null)
  const streamRef = useRef(null)
  const detectorRef = useRef(null)
  const animationFrameRef = useRef(null)
  const fadeTimerRef = useRef(null)
  const gestureNoticeTimerRef = useRef(null)
  const summonedRef = useRef(false)
  const summonFramesRef = useRef(0)
  const undoFramesRef = useRef(0)
  const undoLatchedRef = useRef(false)
  const pinchFramesRef = useRef(0)
  const pinchLatchedRef = useRef(false)
  const drawingEnabledRef = useRef(false)
  const drawingReadyAfterRef = useRef(0)
  const lastIndexExtendedAtRef = useRef(0)
  const swipeRef = useRef({
    stableFrames: 0,
    armedUntil: 0,
    samples: [],
  })
  const lastSwipeTimeRef = useRef(0)
  const lastVideoTimeRef = useRef(-1)
  const lastLandmarkSeenAtRef = useRef(0)
  const smoothedLandmarksRef = useRef(null)
  const trackingFeedbackKeyRef = useRef('')

  const [status, setStatus] = useState('Starting camera…')
  const [error, setError] = useState(null)
  const [gestureNotice, setGestureNotice] = useState(null)
  const [isSummoned, setIsSummoned] = useState(false)
  const [restartKey, setRestartKey] = useState(0)
  const [strokeCount, setStrokeCount] = useState(0)
  const [drawingEnabled, setDrawingEnabled] = useState(false)
  const [trackingFeedback, setTrackingFeedback] = useState({
    kind: 'idle',
    label: 'Looking for your hand',
    progress: 0,
  })
  const [tungs, setTungs] = useState([])

  const updateTrackingFeedback = useCallback((kind, label, progress = 0) => {
    const roundedProgress = Math.round(progress * 10) / 10
    const nextKey = `${kind}:${label}:${roundedProgress}`
    if (trackingFeedbackKeyRef.current === nextKey) return
    trackingFeedbackKeyRef.current = nextKey
    setTrackingFeedback({ kind, label, progress: roundedProgress })
  }, [])

  const showGestureNotice = useCallback((message) => {
    window.clearTimeout(gestureNoticeTimerRef.current)
    setGestureNotice({ id: performance.now(), message })
    gestureNoticeTimerRef.current = window.setTimeout(
      () => setGestureNotice(null),
      1550,
    )
  }, [])

  const changeDrawingMode = useCallback(
    (enabled, announce = true) => {
      drawingEnabledRef.current = enabled
      drawingReadyAfterRef.current = enabled
        ? performance.now() + DRAWING_START_DELAY
        : 0
      lastIndexExtendedAtRef.current = 0
      activePathRef.current = null
      lastPointRef.current = null
      setDrawingEnabled(enabled)
      updateTrackingFeedback(
        enabled ? 'drawing' : 'ready',
        enabled
          ? 'Drawing on · move your index finger'
          : 'Drawing paused · pinch to start',
      )
      if (announce) {
        showGestureNotice(enabled ? 'Drawing activated' : 'Drawing paused')
      }
    },
    [showGestureNotice, updateTrackingFeedback],
  )

  const redrawPaths = useCallback(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    const context = canvas?.getContext('2d')
    if (!context || !stage) return

    const width = stage.clientWidth
    const height = stage.clientHeight
    context.clearRect(0, 0, width, height)
    styleDrawingContext(context)

    if (!summonedRef.current) {
      pathsRef.current.forEach((path) =>
        drawPath(context, path, width, height),
      )
    }
  }, [])

  const clearScene = useCallback(
    (message = 'Canvas cleared') => {
      window.clearTimeout(fadeTimerRef.current)
      summonedRef.current = false
      summonFramesRef.current = 0
      undoFramesRef.current = 0
      undoLatchedRef.current = false
      pinchFramesRef.current = 0
      pinchLatchedRef.current = false
      swipeRef.current = { stableFrames: 0, armedUntil: 0, samples: [] }
      lastIndexExtendedAtRef.current = 0
      pathsRef.current = []
      activePathRef.current = null
      lastPointRef.current = null
      setTungs([])
      setIsSummoned(false)
      setStrokeCount(0)

      const canvas = canvasRef.current
      const stage = stageRef.current
      const context = canvas?.getContext('2d')
      if (context && stage) {
        context.clearRect(0, 0, stage.clientWidth, stage.clientHeight)
      }
      showGestureNotice(message)
    },
    [showGestureNotice],
  )

  const undoLastStroke = useCallback(() => {
    if (summonedRef.current) {
      showGestureNotice('Swipe to clear the swarm first')
      return
    }

    activePathRef.current = null
    lastPointRef.current = null
    if (!pathsRef.current.length) {
      showGestureNotice('Nothing to undo')
      return
    }

    pathsRef.current.pop()
    setStrokeCount(pathsRef.current.length)
    redrawPaths()
    showGestureNotice('Last stroke undone')
  }, [redrawPaths, showGestureNotice])

  useEffect(() => {
    let permissionStatus = null
    let disposed = false

    const retryWhenGranted = () => {
      if (permissionStatus?.state === 'granted') {
        setRestartKey((currentKey) => currentKey + 1)
      }
    }

    navigator.permissions
      ?.query({ name: 'camera' })
      .then((statusResult) => {
        if (disposed) return
        permissionStatus = statusResult
        permissionStatus.addEventListener('change', retryWhenGranted)
      })
      .catch(() => {
        // Some browsers support camera access without exposing camera permissions.
      })

    return () => {
      disposed = true
      permissionStatus?.removeEventListener('change', retryWhenGranted)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let localStream = null
    let localDetector = null

    const getCanvasContext = () => canvasRef.current?.getContext('2d')

    const prepareCanvas = () => {
      const canvas = canvasRef.current
      const stage = stageRef.current
      if (!canvas || !stage) return

      const width = stage.clientWidth
      const height = stage.clientHeight
      const compactCanvas = Math.min(width, height) <= 600
      const pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        compactCanvas ? 1.5 : 2,
      )
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(height * pixelRatio)

      const context = getCanvasContext()
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.clearRect(0, 0, width, height)
      styleDrawingContext(context)

      if (!summonedRef.current) {
        pathsRef.current.forEach((path) =>
          drawPath(context, path, width, height),
        )
      }
    }

    const syncVideoGeometry = () => {
      const video = videoRef.current
      if (video?.videoWidth && video?.videoHeight) {
        video.dataset.streamOrientation =
          video.videoHeight >= video.videoWidth ? 'portrait' : 'landscape'
      }
      prepareCanvas()
    }

    const endActivePath = () => {
      activePathRef.current = null
      lastPointRef.current = null
    }

    const addPoint = (point) => {
      const stage = stageRef.current
      const context = getCanvasContext()
      if (!stage || !context || summonedRef.current) return

      const previous = lastPointRef.current
      if (previous) {
        const pointDistance = Math.hypot(
          point.x - previous.x,
          point.y - previous.y,
        )
        if (pointDistance < MIN_POINT_DISTANCE) return
        if (pointDistance > MAX_POINT_JUMP) {
          activePathRef.current = null
          lastPointRef.current = null
        }
      }

      if (!activePathRef.current) {
        const newPath = [point]
        pathsRef.current.push(newPath)
        activePathRef.current = newPath
        setStrokeCount(pathsRef.current.length)
      } else {
        activePathRef.current.push(point)
      }

      const width = stage.clientWidth
      const height = stage.clientHeight
      const path = activePathRef.current
      const segment = path.length > 1 ? path.slice(-2) : path
      drawPath(context, segment, width, height)
      lastPointRef.current = point
    }

    const summon = () => {
      const pointCount = pathsRef.current.reduce(
        (total, path) => total + path.length,
        0,
      )
      if (!pointCount || summonedRef.current) return

      summonedRef.current = true
      endActivePath()
      drawingEnabledRef.current = false
      drawingReadyAfterRef.current = 0
      lastIndexExtendedAtRef.current = 0
      setDrawingEnabled(false)
      setTungs(
        createSwarm(
          pathsRef.current,
          window.innerWidth <= 600
            ? MAX_COMPACT_TUNGS
            : MAX_DESKTOP_TUNGS,
        ),
      )
      setIsSummoned(true)
      updateTrackingFeedback('swarm', 'Swarm summoned · swipe to clear')

      fadeTimerRef.current = window.setTimeout(() => {
        const canvas = canvasRef.current
        const stage = stageRef.current
        const context = getCanvasContext()
        if (canvas && stage && context) {
          context.clearRect(0, 0, stage.clientWidth, stage.clientHeight)
        }
      }, 950)
    }

    const updateFingerCursor = (point, isDrawing = false) => {
      const cursor = fingerCursorRef.current
      if (!cursor) return
      cursor.style.setProperty('--cursor-x', `${point.x}px`)
      cursor.style.setProperty('--cursor-y', `${point.y}px`)
      cursor.dataset.visible = 'true'
      cursor.dataset.drawing = String(isDrawing)
    }

    const hideFingerCursor = () => {
      if (fingerCursorRef.current) {
        fingerCursorRef.current.dataset.visible = 'false'
        fingerCursorRef.current.dataset.drawing = 'false'
      }
    }

    const advancePalmSwipe = (landmarks, openPalm) => {
      const now = performance.now()
      const palmCenter = getPalmCenter(landmarks)
      const screenPalmX = 1 - palmCenter.x
      const swipe = swipeRef.current

      if (openPalm) {
        swipe.stableFrames += 1
        if (swipe.stableFrames >= 2) {
          swipe.armedUntil = now + SWIPE_ARM_DURATION
        }
      } else {
        swipe.stableFrames = 0
      }

      if (!openPalm && swipe.armedUntil <= now) {
        swipe.samples = []
        return false
      }

      swipe.samples.push({ x: screenPalmX, y: palmCenter.y, time: now })
      swipe.samples = swipe.samples.filter(
        (sample) => now - sample.time <= SWIPE_HISTORY_DURATION,
      )

      const firstSample = swipe.samples[0]
      const horizontalDistance = firstSample
        ? Math.abs(screenPalmX - firstSample.x)
        : 0
      const progress = Math.min(horizontalDistance / SWIPE_DISTANCE, 1)
      const direction =
        firstSample && screenPalmX >= firstSample.x ? 'right' : 'left'
      updateTrackingFeedback(
        'swipe',
        horizontalDistance > 0.018
          ? `Keep swiping ${direction}`
          : 'Open palm ready · swipe sideways',
        progress,
      )

      const detectedSwipe = detectSwipeFromHistory(
        swipe.samples,
        SWIPE_DISTANCE,
        SWIPE_HISTORY_DURATION,
      )
      if (
        detectedSwipe &&
        now - lastSwipeTimeRef.current >= SWIPE_COOLDOWN
      ) {
        lastSwipeTimeRef.current = now
        swipeRef.current = { stableFrames: 0, armedUntil: 0, samples: [] }
        clearScene('Swipe clear')
        updateTrackingFeedback('success', 'Everything cleared', 1)
        return true
      }

      return false
    }

    const processLandmarks = (landmarks) => {
      const video = videoRef.current
      const stage = stageRef.current
      if (!video || !stage || !landmarks) {
        const now = performance.now()
        if (now - lastLandmarkSeenAtRef.current > LANDMARK_RESET_DELAY) {
          endActivePath()
        }
        hideFingerCursor()
        summonFramesRef.current = 0
        undoFramesRef.current = 0
        undoLatchedRef.current = false
        pinchFramesRef.current = 0
        if (swipeRef.current.armedUntil <= now) {
          swipeRef.current = { stableFrames: 0, armedUntil: 0, samples: [] }
        }
        updateTrackingFeedback(
          'idle',
          drawingEnabledRef.current
            ? 'Drawing on · looking for your hand'
            : 'Pinch to activate drawing',
        )
        return
      }

      const videoFit = window.getComputedStyle(video).objectFit || 'cover'
      const indexPoint = mapLandmarkToCover(
        landmarks[8],
        video,
        stage,
        videoFit,
      )
      if (!indexPoint.visible) {
        endActivePath()
        hideFingerCursor()
        updateTrackingFeedback(
          'ready',
          drawingEnabledRef.current
            ? 'Bring your fingertip into frame'
            : 'Pinch to activate drawing',
        )
        return
      }
      updateFingerCursor(indexPoint)
      const pinchRatio = getPinchDistanceRatio(landmarks)
      const gesture = classifyHandGesture(landmarks)

      if (gesture === 'pinch') {
        endActivePath()
        summonFramesRef.current = 0
        undoFramesRef.current = 0
        undoLatchedRef.current = false
        swipeRef.current = { stableFrames: 0, armedUntil: 0, samples: [] }
        pinchFramesRef.current += 1

        if (
          pinchFramesRef.current >= PINCH_HOLD_FRAMES &&
          !pinchLatchedRef.current
        ) {
          pinchLatchedRef.current = true
          changeDrawingMode(!drawingEnabledRef.current)
        }

        updateTrackingFeedback(
          pinchLatchedRef.current ? 'success' : 'pinch',
          pinchLatchedRef.current
            ? drawingEnabledRef.current
              ? 'Drawing activated · release pinch'
              : 'Drawing paused · release pinch'
            : 'Hold pinch to toggle drawing',
          Math.min(pinchFramesRef.current / PINCH_HOLD_FRAMES, 1),
        )
        return
      }

      pinchFramesRef.current = 0
      if (
        pinchLatchedRef.current &&
        pinchRatio < PINCH_RELEASE_RATIO
      ) {
        endActivePath()
        updateTrackingFeedback(
          'success',
          drawingEnabledRef.current
            ? 'Drawing activated · release pinch'
            : 'Drawing paused · release pinch',
          1,
        )
        return
      }
      if (pinchRatio >= PINCH_RELEASE_RATIO) {
        pinchLatchedRef.current = false
      }

      const openPalm = gesture === 'palm'
      if (openPalm || swipeRef.current.armedUntil > performance.now()) {
        endActivePath()
        summonFramesRef.current = 0
        undoFramesRef.current = 0
        undoLatchedRef.current = false
        advancePalmSwipe(landmarks, openPalm)
        return
      }
      swipeRef.current = { stableFrames: 0, armedUntil: 0, samples: [] }

      if (gesture === 'undo' && !summonedRef.current) {
        endActivePath()
        summonFramesRef.current = 0
        undoFramesRef.current += 1
        if (
          undoFramesRef.current >= UNDO_HOLD_FRAMES &&
          !undoLatchedRef.current
        ) {
          undoLatchedRef.current = true
          undoLastStroke()
        }
        updateTrackingFeedback(
          undoLatchedRef.current ? 'success' : 'undo',
          undoLatchedRef.current ? 'Release to continue' : 'Hold L to undo',
          Math.min(undoFramesRef.current / UNDO_HOLD_FRAMES, 1),
        )
        return
      }

      undoFramesRef.current = 0
      undoLatchedRef.current = false

      if (gesture === 'rest') {
        endActivePath()
        summonFramesRef.current = 0
        return
      }

      if (gesture === 'rock') {
        const canSummon =
          summonedRef.current ||
          pathsRef.current.some((path) => path.length >= 2)

        if (!canSummon) {
          summonFramesRef.current = 0
          updateTrackingFeedback(
            drawingEnabledRef.current ? 'drawing' : 'ready',
            drawingEnabledRef.current
              ? 'Point your index finger to draw'
              : 'Draw something before summoning',
          )
          return
        }

        summonFramesRef.current += 1
        if (summonFramesRef.current < SUMMON_CONFIRM_FRAMES) {
          return
        }

        endActivePath()
        updateTrackingFeedback(
          summonedRef.current ? 'swarm' : 'summon',
          summonedRef.current
            ? 'Swipe to clear the swarm'
            : 'Hold 🤘 to summon',
          Math.min(summonFramesRef.current / SUMMON_HOLD_FRAMES, 1),
        )
        if (summonFramesRef.current >= SUMMON_HOLD_FRAMES) {
          summon()
          summonFramesRef.current = 0
        }
        return
      }

      summonFramesRef.current = Math.max(0, summonFramesRef.current - 1)
      const now = performance.now()
      if (gesture === 'point') {
        lastIndexExtendedAtRef.current = now
      }
      const indexIsUsable =
        now - lastIndexExtendedAtRef.current <= INDEX_TRACKING_GRACE
      const drawingIsReady = now >= drawingReadyAfterRef.current

      if (
        drawingEnabledRef.current &&
        drawingIsReady &&
        indexIsUsable &&
        !summonedRef.current
      ) {
        updateFingerCursor(indexPoint, true)
        updateTrackingFeedback('drawing', 'Drawing')
        addPoint(indexPoint)
      } else {
        endActivePath()
        updateTrackingFeedback(
          summonedRef.current ? 'swarm' : 'ready',
          summonedRef.current
            ? 'Swipe an open palm to clear'
            : drawingEnabledRef.current
              ? drawingIsReady
                ? 'Drawing on · point your index finger'
                : 'Drawing activated · get your index ready'
              : 'Drawing paused · pinch to start',
        )
      }
    }

    const track = () => {
      if (disposed) return

      const video = videoRef.current
      const detector = detectorRef.current
      if (
        video &&
        detector &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.currentTime !== lastVideoTimeRef.current
      ) {
        lastVideoTimeRef.current = video.currentTime
        const now = performance.now()
        const result = detector.detectForVideo(video, now)
        const rawLandmarks = result.landmarks?.[0]
        if (rawLandmarks) {
          lastLandmarkSeenAtRef.current = now
          smoothedLandmarksRef.current = smoothLandmarks(
            rawLandmarks,
            smoothedLandmarksRef.current,
          )
          processLandmarks(smoothedLandmarksRef.current)
        } else {
          if (
            now - lastLandmarkSeenAtRef.current >
            LANDMARK_RESET_DELAY
          ) {
            smoothedLandmarksRef.current = null
          }
          processLandmarks(null)
        }
      }
      animationFrameRef.current = requestAnimationFrame(track)
    }

    const createDetector = async (FilesetResolver, HandLandmarker) => {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM)
      const options = {
        baseOptions: {
          modelAssetPath: HAND_MODEL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.35,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.4,
      }

      try {
        return await HandLandmarker.createFromOptions(vision, options)
      } catch {
        return HandLandmarker.createFromOptions(vision, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: 'CPU' },
        })
      }
    }

    const start = async () => {
      try {
        setError(null)
        setStatus('Starting camera…')

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera access is not supported in this browser.')
        }

        prepareCanvas()
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: getCameraConstraints(stageRef.current),
        })
        if (disposed) {
          localStream.getTracks().forEach((trackItem) => trackItem.stop())
          return
        }
        streamRef.current = localStream

        const video = videoRef.current
        video.srcObject = localStream
        await video.play()
        syncVideoGeometry()
        setStatus('Loading hand tracking…')

        const { FilesetResolver, HandLandmarker } = await import(
          /* @vite-ignore */ MEDIAPIPE_MODULE
        )
        localDetector = await createDetector(
          FilesetResolver,
          HandLandmarker,
        )
        if (disposed) {
          localDetector.close()
          return
        }
        detectorRef.current = localDetector

        setStatus('')
        setError(null)
        animationFrameRef.current = requestAnimationFrame(track)
      } catch (caughtError) {
        if (disposed) return
        console.error('[Triple T Loves You] startup failed', caughtError)
        localDetector?.close()
        localStream?.getTracks().forEach((trackItem) => trackItem.stop())
        if (videoRef.current) videoRef.current.srcObject = null
        setStatus('')
        const permissionDenied = caughtError?.name === 'NotAllowedError'
        const trackingFailed =
          !permissionDenied &&
          /mediapipe|fetch|module|wasm|landmark/i.test(
            caughtError?.message || '',
          )

        setError({
          title: permissionDenied
            ? 'Camera access needed'
            : trackingFailed
              ? 'Hand tracking could not load'
              : 'Camera unavailable',
          message: permissionDenied
            ? 'Allow camera access in Chrome, then choose Try camera again.'
            : trackingFailed
              ? 'Check your internet connection, then try loading hand tracking again.'
              : caughtError?.message || 'Could not start the camera.',
        })
      }
    }

    const videoElement = videoRef.current
    const resizeObserver = new ResizeObserver(prepareCanvas)
    if (stageRef.current) resizeObserver.observe(stageRef.current)
    window.addEventListener('resize', prepareCanvas)
    window.visualViewport?.addEventListener('resize', prepareCanvas)
    videoElement?.addEventListener('loadedmetadata', syncVideoGeometry)
    videoElement?.addEventListener('resize', syncVideoGeometry)
    start()

    return () => {
      disposed = true
      resizeObserver.disconnect()
      window.removeEventListener('resize', prepareCanvas)
      window.visualViewport?.removeEventListener('resize', prepareCanvas)
      videoElement?.removeEventListener('loadedmetadata', syncVideoGeometry)
      videoElement?.removeEventListener('resize', syncVideoGeometry)
      cancelAnimationFrame(animationFrameRef.current)
      window.clearTimeout(fadeTimerRef.current)
      localDetector?.close()
      localStream?.getTracks().forEach((trackItem) => trackItem.stop())
    }
  }, [
    changeDrawingMode,
    clearScene,
    restartKey,
    undoLastStroke,
    updateTrackingFeedback,
  ])

  useEffect(
    () => () => window.clearTimeout(gestureNoticeTimerRef.current),
    [],
  )

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undoLastStroke()
      } else if (
        event.key.toLowerCase() === 'c' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        clearScene('Canvas cleared')
      } else if (
        event.key.toLowerCase() === 'd' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !summonedRef.current
      ) {
        changeDrawingMode(!drawingEnabledRef.current)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [changeDrawingMode, clearScene, undoLastStroke])

  const handleRetry = () => {
    setRestartKey((currentKey) => currentKey + 1)
  }

  const handleClear = () => {
    clearScene('Canvas cleared')
  }

  const handleDrawingToggle = () => {
    changeDrawingMode(!drawingEnabledRef.current)
  }

  return (
    <main
      className={`app${drawingEnabled ? ' app--drawing' : ''}`}
      ref={stageRef}
    >
      <video
        aria-label="Mirrored live camera"
        autoPlay
        className="camera-feed"
        muted
        playsInline
        ref={videoRef}
      />
      <div className="camera-vignette" aria-hidden="true" />
      <canvas
        aria-hidden="true"
        className={`drawing-canvas${isSummoned ? ' drawing-canvas--fade' : ''}`}
        ref={canvasRef}
      />
      <div
        className="finger-cursor"
        data-drawing="false"
        data-visible="false"
        ref={fingerCursorRef}
      >
        <span />
      </div>
      <TungSwarm tungs={tungs} />

      <header className="top-bar">
        <div className="brand" aria-label="Triple T Loves You">
          <span className="brand-mark" aria-hidden="true">TT</span>
          <span>Triple T Loves You</span>
        </div>
        <div className="toolbar" aria-label="Canvas controls">
          <button
            aria-pressed={drawingEnabled}
            className={`tool-button tool-button--mode${
              drawingEnabled ? ' is-active' : ''
            }`}
            disabled={isSummoned}
            onClick={handleDrawingToggle}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m4 20 3.8-.8L19 8l-3-3L4.8 16.2 4 20Zm9.8-12.8 3 3" />
            </svg>
            <span className="tool-button-label">
              {drawingEnabled ? 'Draw on' : 'Draw off'}
            </span>
          </button>
          <button
            className="tool-button"
            disabled={!strokeCount || isSummoned}
            onClick={undoLastStroke}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m9 8-5 4 5 4m-4.5-4H14a6 6 0 0 1 6 6" />
            </svg>
            <span className="tool-button-label">Undo</span>
          </button>
          <button
            className="tool-button"
            disabled={!strokeCount && !isSummoned}
            onClick={handleClear}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
            </svg>
            <span className="tool-button-label">Clear</span>
          </button>
        </div>
      </header>

      {!status && !error && (
        <div
          className={`tracking-pill tracking-pill--${trackingFeedback.kind}`}
          role="status"
          style={{
            '--gesture-progress': `${trackingFeedback.progress * 100}%`,
          }}
        >
          <span className="tracking-dot" aria-hidden="true" />
          <span>{trackingFeedback.label}</span>
          {['pinch', 'swipe', 'undo', 'summon'].includes(
            trackingFeedback.kind,
          ) && (
            <span className="tracking-progress" aria-hidden="true" />
          )}
        </div>
      )}

      {status && (
        <div className="status-pill" role="status">
          <span className="status-dot" />
          {status}
        </div>
      )}

      {error && (
        <section className="error-card" role="alert">
          <span className="error-icon" aria-hidden="true">!</span>
          <h1>{error.title}</h1>
          <p>{error.message}</p>
          <button className="retry-button" onClick={handleRetry} type="button">
            Try camera again
          </button>
        </section>
      )}

      {gestureNotice && (
        <div
          className="gesture-notice"
          key={gestureNotice.id}
          role="status"
        >
          {gestureNotice.message}
        </div>
      )}

      <div className="instruction" aria-label="Gesture controls">
        <span className="instruction-spark" aria-hidden="true" />
        <span className="gesture-item">
          <span className="gesture-key">PINCH</span>
          <span className="gesture-action">Draw on / off</span>
        </span>
        <span className="instruction-divider" aria-hidden="true">·</span>
        <span className="gesture-item">
          <span className="gesture-key">L SIGN</span>
          <span className="gesture-action">Undo</span>
        </span>
        <span className="instruction-divider" aria-hidden="true">·</span>
        <span className="gesture-item">
          <span className="gesture-key">PALM</span>
          <span className="gesture-action">Swipe to clear</span>
        </span>
        <span className="instruction-divider" aria-hidden="true">·</span>
        <span className="gesture-item">
          <span
            aria-label="Rock horns gesture"
            className="gesture-key gesture-key--rock"
          >
            <span aria-hidden="true" className="gesture-emoji">🤘</span>
            ROCK
          </span>
          <span className="gesture-action">Summon</span>
        </span>
      </div>
    </main>
  )
}
