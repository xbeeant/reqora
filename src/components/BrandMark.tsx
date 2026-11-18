/**
 * Reqora brand mark — a request going out and a response coming back.
 * Keep in sync with public/reqora.svg, the single source for all platform icons.
 */
export function BrandMark({ className = "wb-brand-mark" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Reqora"
    >
      <title>Reqora</title>
      <rect width="64" height="64" rx="15" fill="#0B84FF" />
      <path d="M17 25h21" fill="none" stroke="#fff" strokeWidth={4.6} strokeLinecap="round" />
      <path d="M34 19.5l6.5 5.5-6.5 5.5" fill="none" stroke="#fff" strokeWidth={4.6} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M47 39H26" fill="none" stroke="#fff" strokeWidth={4.6} strokeLinecap="round" opacity={0.72} />
      <path d="M30 33.5L23.5 39l6.5 5.5" fill="none" stroke="#fff" strokeWidth={4.6} strokeLinecap="round" strokeLinejoin="round" opacity={0.72} />
    </svg>
  );
}
