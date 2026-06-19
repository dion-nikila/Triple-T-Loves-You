import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyHandGesture,
  detectSwipeFromHistory,
  isClosedFist,
  isIndexExtended,
  isOpenPalm,
  isPeaceSign,
  isPinching,
  isUndoSign,
  mapLandmarkToCover,
  smoothLandmarks,
} from './handGestures.js'

const fingers = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
}

function makeHand(extendedFingers = []) {
  const hand = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.7, z: 0 }))
  hand[0] = { x: 0.5, y: 0.9, z: 0 }
  hand[1] = { x: 0.4, y: 0.72, z: 0 }
  hand[2] = { x: 0.35, y: 0.66, z: 0 }
  hand[3] = { x: 0.31, y: 0.62, z: 0 }
  hand[4] = { x: 0.28, y: 0.6, z: 0 }

  Object.entries(fingers).forEach(([finger, [mcp, pip, dip, tip]], index) => {
    const x = 0.4 + index * 0.07
    hand[mcp] = { x, y: 0.65, z: 0 }
    if (extendedFingers.includes(finger)) {
      hand[pip] = { x, y: 0.52, z: 0 }
      hand[dip] = { x, y: 0.39, z: 0 }
      hand[tip] = { x, y: 0.26, z: 0 }
    } else {
      hand[pip] = { x, y: 0.53, z: 0 }
      hand[dip] = { x, y: 0.6, z: 0 }
      hand[tip] = { x, y: 0.55, z: 0 }
    }
  })

  return hand
}

test('recognizes the core hand poses without requiring a perfect orientation', () => {
  assert.equal(isClosedFist(makeHand()), true)
  assert.equal(isIndexExtended(makeHand(['index'])), true)
  assert.equal(isPeaceSign(makeHand(['index', 'middle'])), true)
  assert.equal(
    isOpenPalm(makeHand(['index', 'middle', 'ring', 'pinky'])),
    true,
  )
})

test('classifies gestures exclusively so actions cannot compete', () => {
  assert.equal(classifyHandGesture(makeHand()), 'fist')
  assert.equal(classifyHandGesture(makeHand(['index'])), 'point')
  assert.equal(
    classifyHandGesture(makeHand(['index', 'middle', 'ring', 'pinky'])),
    'palm',
  )

  const undo = makeHand(['index'])
  undo[4] = { x: 0.2, y: 0.65, z: 0 }
  assert.equal(isUndoSign(undo), true)
  assert.equal(classifyHandGesture(undo), 'undo')

  const pinch = makeHand(['index'])
  pinch[4] = { ...pinch[8], x: pinch[8].x - 0.01 }
  assert.equal(classifyHandGesture(pinch), 'pinch')
})

test('recognizes a fist despite noisy straight-looking knuckles', () => {
  const noisyFist = makeHand()
  noisyFist[6] = { x: 0.45, y: 0.62, z: 0 }
  noisyFist[7] = { x: 0.5, y: 0.59, z: 0 }
  noisyFist[8] = { x: 0.55, y: 0.56, z: 0 }

  assert.equal(isIndexExtended(noisyFist), true)
  assert.equal(isClosedFist(noisyFist), true)
  assert.equal(classifyHandGesture(noisyFist), 'fist')
})

test('does not confuse a deliberate pointing hand with a fist', () => {
  const pointingHand = makeHand(['index'])

  assert.equal(isClosedFist(pointingHand), false)
  assert.equal(classifyHandGesture(pointingHand), 'point')
})

test('does not classify a loose drawing hand as a fist', () => {
  const drawingHand = makeHand(['index'])
  drawingHand[8] = { x: 0.4, y: 0.38, z: 0 }

  assert.equal(isClosedFist(drawingHand), false)
  assert.equal(classifyHandGesture(drawingHand), 'point')
})

test('normalizes pinch distance by palm size', () => {
  const hand = makeHand(['index'])
  hand[4] = { ...hand[8], x: hand[8].x - 0.01 }
  assert.equal(isPinching(hand), true)
})

test('detects a clean horizontal swipe after noisy lead-in motion', () => {
  const swipe = detectSwipeFromHistory(
    [
      { x: 0.2, y: 0.2, time: 0 },
      { x: 0.3, y: 0.5, time: 80 },
      { x: 0.41, y: 0.51, time: 180 },
    ],
    0.095,
  )
  assert.deepEqual(swipe, { direction: 'right', distance: 0.10999999999999999 })
})

test('rejects predominantly vertical movement as a swipe', () => {
  const swipe = detectSwipeFromHistory([
    { x: 0.2, y: 0.2, time: 0 },
    { x: 0.25, y: 0.5, time: 180 },
  ])
  assert.equal(swipe, null)
})

test('adaptive smoothing responds faster to deliberate movement than jitter', () => {
  const previous = makeHand(['index'])
  const near = previous.map((landmark) => ({ ...landmark }))
  const far = previous.map((landmark) => ({ ...landmark }))
  near[8].x += 0.006
  far[8].x += 0.08

  const nearResult = smoothLandmarks(near, previous)
  const farResult = smoothLandmarks(far, previous)
  const nearResponse = nearResult[8].x - previous[8].x
  const farResponseRatio =
    (farResult[8].x - previous[8].x) / (far[8].x - previous[8].x)
  const nearResponseRatio = nearResponse / (near[8].x - previous[8].x)

  assert.ok(farResponseRatio > nearResponseRatio)
})

test('maps mirrored landmarks to a portrait cover crop', () => {
  const video = { videoWidth: 1280, videoHeight: 720 }
  const container = { clientWidth: 390, clientHeight: 844 }

  const center = mapLandmarkToCover({ x: 0.5, y: 0.5 }, video, container)
  assert.equal(center.x, 195)
  assert.equal(center.y, 422)
  assert.equal(center.visible, true)

  const croppedEdge = mapLandmarkToCover(
    { x: 0.05, y: 0.5 },
    video,
    container,
  )
  assert.equal(croppedEdge.visible, false)
})

test('supports contained camera frames without distorting coordinates', () => {
  const video = { videoWidth: 720, videoHeight: 1280 }
  const container = { clientWidth: 390, clientHeight: 844 }
  const point = mapLandmarkToCover(
    { x: 0.25, y: 0.75 },
    video,
    container,
    'contain',
  )

  assert.ok(Math.abs(point.x - 292.5) < 0.001)
  assert.ok(Math.abs(point.y - 595.3333333333334) < 0.001)
  assert.equal(point.visible, true)
})

test('maps landmarks inside a centered mobile camera frame', () => {
  const video = {
    videoWidth: 1280,
    videoHeight: 720,
    getBoundingClientRect: () => ({
      left: 10,
      top: 175,
      width: 370,
      height: 494,
    }),
  }
  const container = {
    clientWidth: 390,
    clientHeight: 844,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 390,
      height: 844,
    }),
  }

  const center = mapLandmarkToCover({ x: 0.5, y: 0.5 }, video, container)
  assert.equal(center.x, 195)
  assert.equal(center.y, 422)
  assert.equal(center.visible, true)

  const croppedEdge = mapLandmarkToCover(
    { x: 0.05, y: 0.5 },
    video,
    container,
  )
  assert.equal(croppedEdge.visible, false)
})
