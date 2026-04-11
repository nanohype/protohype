interface Props {
  label: "sonnet" | "opus" | "haiku";
}

const styles = {
  sonnet: "bg-blue-950 text-blue-400 border-blue-800",
  opus: "bg-purple-950 text-purple-400 border-purple-800",
  haiku: "bg-cyan-950 text-cyan-400 border-cyan-800",
} as const;

export default function ModelBadge({ label }: Props) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wide ${styles[label]}`}>
      {label}
    </span>
  );
}
