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
  // An icon with no alt text is decorative — almost always inside a link or
  // button that already names itself. Announcing it as an image with an empty
  // name adds a nameless stop for screen-reader users, so hide it instead.
  const decorative = alt.length === 0;
  if (tint) {
    return (
      <span
        {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": alt })}
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
  return (
    // Exact Figma asset bytes — next/image would re-encode them.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      {...(decorative ? { "aria-hidden": true } : {})}
      className={cn("block shrink-0", className)}
    />
  );
}
