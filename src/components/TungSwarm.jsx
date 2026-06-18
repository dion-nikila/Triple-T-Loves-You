import { memo } from 'react'

export const TungSwarm = memo(function TungSwarm({ tungs }) {
  return (
    <div className="tung-layer" aria-hidden="true">
      {tungs.map((tung) => (
        <div
          className="tung-pop"
          key={tung.id}
          style={{
            '--x': `${tung.x * 100}%`,
            '--y': `${tung.y * 100}%`,
            '--size': `${tung.size}px`,
            '--spawn-delay': `${tung.delay}ms`,
          }}
        >
          <img
            alt=""
            className="tung-character"
            draggable="false"
            src="/tung.png"
            style={{
              '--rotation': `${tung.rotation}deg`,
              '--wiggle-duration': `${tung.duration}ms`,
              '--wiggle-delay': `${tung.wiggleDelay}ms`,
            }}
          />
        </div>
      ))}
    </div>
  )
})
