import { useEffect, useRef } from "react";

type StepButtonProps = {
  delta: number;
  disabled: boolean;
  label: string;
  onStep: (delta: number) => void;
  symbol: string;
};

function StepButton({ delta, disabled, label, onStep, symbol }: StepButtonProps) {
  const delayRef = useRef<number | null>(null);
  const repeatRef = useRef<number | null>(null);
  const stop = () => {
    if (delayRef.current !== null) window.clearTimeout(delayRef.current);
    if (repeatRef.current !== null) window.clearInterval(repeatRef.current);
    delayRef.current = null;
    repeatRef.current = null;
  };
  useEffect(() => stop, []);

  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        if (event.detail === 0) onStep(delta);
      }}
      onLostPointerCapture={stop}
      onPointerCancel={stop}
      onPointerDown={(event) => {
        if (event.button !== 0 || disabled) return;
        stop();
        onStep(delta);
        event.currentTarget.setPointerCapture(event.pointerId);
        delayRef.current = window.setTimeout(() => {
          onStep(delta);
          repeatRef.current = window.setInterval(() => onStep(delta), 75);
        }, 350);
      }}
      onPointerUp={stop}
      type="button"
    >
      {symbol}
    </button>
  );
}

type ThresholdControlProps = {
  disabled: boolean;
  loose: number;
  strict: number;
  value: number;
  onChange: (value: number) => void;
};

export default function ThresholdControl({
  disabled,
  loose,
  strict,
  value,
  onChange,
}: ThresholdControlProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const step = (delta: number) => {
    const nextValue = Math.round((valueRef.current + delta) * 1_000_000) / 1_000_000;
    valueRef.current = nextValue;
    onChange(nextValue);
  };
  const sliderValue = Math.min(loose, Math.max(strict, value));
  return (
    <div className="threshold-control">
      <div className="threshold-bounds">
        <span>strict <code>{strict.toFixed(6)}</code></span>
        <span>loose <code>{loose.toFixed(6)}</code></span>
      </div>
      <div className="threshold-value">
        <label htmlFor="selected-threshold">当前阈值</label>
        <output>{value.toFixed(6)}</output>
      </div>
      <div className="threshold-input">
        <input
          disabled={disabled}
          id="selected-threshold"
          max={loose}
          min={strict}
          onChange={(event) => onChange(Number(event.target.value))}
          step="0.0001"
          type="range"
          value={sliderValue}
        />
        <StepButton delta={-0.001} disabled={disabled} label="阈值减少 0.001" onStep={step} symbol="−" />
        <StepButton delta={0.001} disabled={disabled} label="阈值增加 0.001" onStep={step} symbol="+" />
      </div>
    </div>
  );
}
