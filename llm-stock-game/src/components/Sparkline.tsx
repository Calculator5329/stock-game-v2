type Props = {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
};

export function Sparkline({ values, width = 120, height = 36, stroke = "#1976d2", fill }: Props) {
  const clean = (values || []).filter(Number.isFinite);
  if (clean.length < 2) {
    return <svg width={width} height={height} />;
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;

  const points = clean.map((v, i) => {
    const x = (i / (clean.length - 1)) * (width - 2) + 1;
    const y = height - 1 - ((v - min) / range) * (height - 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const path = `M ${points.join(" L ")}`;
  const area = `M 1,${height - 1} L ${points.join(" L ")} L ${width - 1},${height - 1} Z`;

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {fill && <path d={area} fill={fill} opacity={0.15} />}
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}


