import { useEffect } from "react";

export interface PageMeta {
  /** Document title + `og:title` / `twitter:title`. */
  title: string;
  /** `<meta name="description">` + `og:description` / `twitter:description`. */
  description?: string;
  /** OG/Twitter card image — a path (`/og-x.png`) or URL; resolved absolute against the origin. */
  image?: string;
  /** `og:image:alt` / `twitter:image:alt`. */
  imageAlt?: string;
}

/**
 * Per-route document head for the SPA: sets the title + Open Graph / Twitter card meta and restores
 * the previous values when the route unmounts. CAVEAT: most social crawlers (Slack, Discord, X,
 * iMessage…) don't run JS, so they still read the STATIC tags in index.html — this only updates the
 * browser tab and JS-capable unfurlers. Real per-route unfurls need prerendering/SSR (see PR notes).
 */
export function usePageMeta(meta: PageMeta): void {
  const { title, description, image, imageAlt } = meta;
  useEffect(() => {
    const restores: Array<() => void> = [];

    const prevTitle = document.title;
    document.title = title;
    restores.push(() => {
      document.title = prevTitle;
    });

    // Crawlers prefer an absolute image URL; resolve a "/og-x.png" path against the live origin.
    const absImage = image
      ? new URL(image, window.location.origin).href
      : undefined;

    // Upsert a meta tag, remembering whether it pre-existed so cleanup either restores its prior
    // content or removes the tag we created — leaving index.html's defaults intact after unmount.
    const apply = (
      kind: "name" | "property",
      key: string,
      content?: string,
    ) => {
      if (content == null) return;
      let el = document.head.querySelector<HTMLMetaElement>(
        `meta[${kind}="${key}"]`,
      );
      const existed = el != null;
      const prev = el?.getAttribute("content") ?? null;
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(kind, key);
        document.head.appendChild(el);
      }
      const node = el;
      node.setAttribute("content", content);
      restores.push(() => {
        if (!existed) node.remove();
        else if (prev != null) node.setAttribute("content", prev);
      });
    };

    apply("name", "description", description);
    apply("property", "og:title", title);
    apply("property", "og:description", description);
    apply("property", "og:image", absImage);
    apply("property", "og:image:alt", imageAlt);
    apply("name", "twitter:title", title);
    apply("name", "twitter:description", description);
    apply("name", "twitter:image", absImage);
    apply("name", "twitter:image:alt", imageAlt);

    // Restore in reverse so a tag we created-then-restored is removed exactly once.
    return () => {
      for (let i = restores.length - 1; i >= 0; i--) restores[i]();
    };
  }, [title, description, image, imageAlt]);
}
