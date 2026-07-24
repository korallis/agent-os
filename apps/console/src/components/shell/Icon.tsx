import { cn } from "@agent-os/ui";

interface IconProps {
  /** Path under /figma, e.g. "nav-home.svg". */
  src: string;
  /** Tailwind size classes, e.g. "size-5". */
  className?: string;
  /** When set, renders the exported vector through a CSS mask so the exact
      geometry can be tinted (active/inactive states). */
  tint?: string;
  alt?: string;
}

/**
 * Renders a Figma-exported asset. Monochrome icons use a CSS mask over the
 * committed SVG so states can re-tint the exact exported geometry; everything
 * else renders the asset bytes directly.
 */
export function Icon({ src, className, tint, alt = "" }: IconProps) {
  const url = `/figma/${src}`;
  if (tint) {
    return (
      <span
        role="img"
        aria-label={alt}
        className={cn("inline-block shrink-0", className)}
        style={{
          backgroundColor: tint,
          maskImage: `url(${url})`,
          maskSize: "100% 100%",
          maskRepeat: "no-repeat",
          WebkitMaskImage: `url(${url})`,
          WebkitMaskSize: "100% 100%",
          WebkitMaskRepeat: "no-repeat",
        }}
      />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- exact Figma asset bytes
  return <img src={url} alt={alt} className={cn("block shrink-0", className)} />;
}
