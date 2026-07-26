/**
 * Shared UI surface for Agent OS.
 *
 * This package used to carry a much larger surface — animation primitives,
 * motion variants, a glass card, a magnetic button and a site header — all of
 * which existed solely for the marketing site. Agent OS is a local-only,
 * single-user web app, so that site was removed, and with it every export here
 * that only it consumed.
 *
 * The Console imports exactly two things from this package: `cn`, and the theme
 * stylesheet via `@agent-os/ui/styles.css`. Keeping the rest would have meant
 * maintaining, typechecking and lint-clean-ing a component library with no
 * consumer.
 */

export { cn } from "./lib/cn";
