const FINGER_JOINTS = {
  index: { mcp: 5, pip: 6, dip: 7, tip: 8 },
  middle: { mcp: 9, pip: 10, dip: 11, tip: 12 },
  ring: { mcp: 13, pip: 14, dip: 15, tip: 16 },
  pinky: { mcp: 17, pip: 18, dip: 19, tip: 20 },
}

const distance = (first, second) =>
  Math.hypot(first.x - second.x, first.y - second.y)

const jointAngle = (first, pivot, last) => {
  const firstVector = {
    x: first.x - pivot.x,
    y: first.y - pivot.y,
  }
  const lastVector = {
    x: last.x - pivot.x,
    y: last.y - pivot.y,
  }
  const magnitude =
    Math.hypot(firstVector.x, firstVector.y) *
    Math.hypot(lastVector.x, lastVector.y)
  if (!magnitude) return 0

  const cosine =
    (firstVector.x * lastVector.x + firstVector.y * lastVector.y) /
    magnitude
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI
}

const isExtended = (landmarks, finger) => {
  const { mcp, pip, dip, tip } = FINGER_JOINTS[finger]
  const pipAngle = jointAngle(
    landmarks[mcp],
    landmarks[pip],
    landmarks[dip],
  )
  const dipAngle = jointAngle(
    landmarks[pip],
    landmarks[dip],
    landmarks[tip],
  )
  return (
    pipAngle > 135 &&
    dipAngle > 135 &&
    distance(landmarks[tip], landmarks[0]) >
      distance(landmarks[pip], landmarks[0]) * 1.02
  )
}

export function getPinchDistanceRatio(landmarks) {
  const palmScale = distance(landmarks[0], landmarks[9]) || 0.1
  return distance(landmarks[4], landmarks[8]) / palmScale
}

export function isPinching(landmarks, threshold = 0.38) {
  return getPinchDistanceRatio(landmarks) < threshold
}

export function isIndexPointing(landmarks) {
  const indexExtended = isExtended(landmarks, 'index')
  const middleFolded = !isExtended(landmarks, 'middle')
  const outerFolded = ['ring', 'pinky'].filter(
    (finger) => !isExtended(landmarks, finger),
  ).length
  const palmScale = distance(landmarks[0], landmarks[9]) || 0.1
  const indexReach =
    distance(landmarks[8], getPalmCenter(landmarks)) / palmScale

  return (
    indexExtended &&
    middleFolded &&
    outerFolded >= 1 &&
    indexReach > 1.15
  )
}

export function isIndexExtended(landmarks) {
  return isExtended(landmarks, 'index')
}

export function isClosedFist(landmarks) {
  const palmCenter = getPalmCenter(landmarks)
  const palmScale = distance(landmarks[0], landmarks[9]) || 0.1
  let curledFingers = 0
  let stronglyExtendedFingers = 0

  Object.entries(FINGER_JOINTS).forEach(([finger, joints]) => {
    const tipDistance = distance(landmarks[joints.tip], palmCenter) / palmScale
    const tuckedIntoPalm = tipDistance < 1.2

    if (tuckedIntoPalm) {
      curledFingers += 1
    }
    if (isExtended(landmarks, finger) && tipDistance > 1.55) {
      stronglyExtendedFingers += 1
    }
  })

  return curledFingers === 4 && stronglyExtendedFingers === 0
}

export function isOpenPalm(landmarks) {
  const extendedFingers = ['index', 'middle', 'ring', 'pinky'].filter(
    (finger) => isExtended(landmarks, finger),
  )
  return extendedFingers.length >= 3
}

export function isPeaceSign(landmarks) {
  const palmScale = distance(landmarks[0], landmarks[9]) || 0.1
  const fingerSpread = distance(landmarks[8], landmarks[12]) / palmScale

  return (
    isExtended(landmarks, 'index') &&
    isExtended(landmarks, 'middle') &&
    !isExtended(landmarks, 'ring') &&
    !isExtended(landmarks, 'pinky') &&
    fingerSpread > 0.16
  )
}

export function isUndoSign(landmarks) {
  const palmScale = distance(landmarks[0], landmarks[9]) || 0.1
  const thumbSpread = distance(landmarks[4], landmarks[5]) / palmScale

  return (
    isExtended(landmarks, 'index') &&
    !isExtended(landmarks, 'middle') &&
    !isExtended(landmarks, 'ring') &&
    !isExtended(landmarks, 'pinky') &&
    thumbSpread > 0.7
  )
}

export function classifyHandGesture(landmarks) {
  const index = isExtended(landmarks, 'index')
  const middle = isExtended(landmarks, 'middle')
  const ring = isExtended(landmarks, 'ring')
  const pinky = isExtended(landmarks, 'pinky')
  const extendedCount = [index, middle, ring, pinky].filter(Boolean).length

  if (isPinching(landmarks)) return 'pinch'
  if (extendedCount >= 3) return 'palm'
  if (isUndoSign(landmarks)) return 'undo'
  if (isIndexPointing(landmarks)) return 'point'
  if (isClosedFist(landmarks)) return 'fist'
  return 'neutral'
}

export function shouldHandleFistGesture(gesture, drawingEnabled) {
  return gesture === 'fist' && !drawingEnabled
}

export function smoothLandmarks(landmarks, previousLandmarks) {
  if (!previousLandmarks?.length) {
    return landmarks.map((landmark) => ({ ...landmark }))
  }

  return landmarks.map((landmark, index) => {
    const previous = previousLandmarks[index]
    const movement = distance(landmark, previous)
    const alpha = Math.min(0.86, 0.42 + movement * 8)

    return {
      x: landmark.x * alpha + previous.x * (1 - alpha),
      y: landmark.y * alpha + previous.y * (1 - alpha),
      z:
        (landmark.z ?? 0) * alpha +
        (previous.z ?? 0) * (1 - alpha),
    }
  })
}

export function getPalmCenter(landmarks) {
  const palmLandmarks = [0, 5, 9, 13, 17]
  const total = palmLandmarks.reduce(
    (center, index) => ({
      x: center.x + landmarks[index].x,
      y: center.y + landmarks[index].y,
    }),
    { x: 0, y: 0 },
  )

  return {
    x: total.x / palmLandmarks.length,
    y: total.y / palmLandmarks.length,
  }
}

export function isHorizontalSwipe(
  start,
  current,
  minimumDistance = 0.13,
  horizontalRatio = 1.1,
) {
  const horizontalDistance = Math.abs(current.x - start.x)
  const verticalDistance = Math.abs(current.y - start.y)
  return (
    horizontalDistance >= minimumDistance &&
    horizontalDistance > verticalDistance * horizontalRatio
  )
}

export function detectSwipeFromHistory(
  samples,
  minimumDistance = 0.1,
  maximumDuration = 760,
  horizontalRatio = 1.05,
) {
  if (samples.length < 2) return null

  const last = samples[samples.length - 1]
  let strongestSwipe = null

  for (const sample of samples) {
    const duration = last.time - sample.time
    if (duration < 70 || duration > maximumDuration) continue

    const deltaX = last.x - sample.x
    const deltaY = last.y - sample.y
    const horizontalDistance = Math.abs(deltaX)
    if (
      horizontalDistance >= minimumDistance &&
      horizontalDistance > Math.abs(deltaY) * horizontalRatio &&
      (!strongestSwipe || horizontalDistance > strongestSwipe.distance)
    ) {
      strongestSwipe = {
        direction: deltaX > 0 ? 'right' : 'left',
        distance: horizontalDistance,
      }
    }
  }

  return strongestSwipe
}

export function mapLandmarkToCover(
  landmark,
  video,
  container,
  fit = 'cover',
) {
  const containerRect = container.getBoundingClientRect?.()
  const videoRect = video.getBoundingClientRect?.()
  const containerWidth = containerRect?.width || container.clientWidth
  const containerHeight = containerRect?.height || container.clientHeight
  const displayWidth = videoRect?.width || video.clientWidth || containerWidth
  const displayHeight = videoRect?.height || video.clientHeight || containerHeight
  const displayLeft = videoRect
    ? videoRect.left - (containerRect?.left || 0)
    : video.offsetLeft || 0
  const displayTop = videoRect
    ? videoRect.top - (containerRect?.top || 0)
    : video.offsetTop || 0
  const videoWidth = video.videoWidth || containerWidth
  const videoHeight = video.videoHeight || containerHeight
  const scaleCandidates = [
    displayWidth / videoWidth,
    displayHeight / videoHeight,
  ]
  const scale =
    fit === 'contain'
      ? Math.min(...scaleCandidates)
      : Math.max(...scaleCandidates)
  const renderedWidth = videoWidth * scale
  const renderedHeight = videoHeight * scale
  const offsetX = (displayWidth - renderedWidth) / 2
  const offsetY = (displayHeight - renderedHeight) / 2
  const unmirroredX = landmark.x * renderedWidth + offsetX
  const x = displayLeft + displayWidth - unmirroredX
  const y = displayTop + landmark.y * renderedHeight + offsetY

  return {
    x,
    y,
    nx: x / containerWidth,
    ny: y / containerHeight,
    visible:
      x >= displayLeft &&
      x <= displayLeft + displayWidth &&
      y >= displayTop &&
      y <= displayTop + displayHeight,
  }
}
