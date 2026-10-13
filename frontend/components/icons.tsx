// Small stroke icons, drawn inline so the UI needs no icon package.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: string[]) {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  };
}

export const ArrowRight = make(["M5 12h14", "M13 6l6 6-6 6"]);
export const ArrowDownToLine = make(["M12 4v12", "M6 11l6 6 6-6", "M5 20h14"]);
export const ChevronDown = make(["M6 9l6 6 6-6"]);
export const ChevronRight = make(["M9 6l6 6-6 6"]);
export const Upload = make(["M12 16V4", "M6 9l6-6 6 6", "M5 20h14"]);
export const X = make(["M6 6l12 12", "M18 6L6 18"]);
export const Send = make(["M4 12h15", "M13 6l6 6-6 6"]);
export const Refresh = make(["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"]);
export const Layers = make(["M12 3l9 5-9 5-9-5 9-5z", "M3 13l9 5 9-5"]);
export const MessageGrid = make(["M4 5h16v11H9l-5 4V5z", "M8 9h8", "M8 12h5"]);
export const Flow = make(["M4 6h5v4H4z", "M15 14h5v4h-5z", "M9 8h3a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2", "M4 16h5"]);
export const Spark = make(["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "M6 6l2.5 2.5", "M15.5 15.5L18 18", "M18 6l-2.5 2.5", "M8.5 15.5L6 18"]);
export const Home = make(["M4 11l8-7 8 7", "M6 9.5V20h12V9.5", "M10 20v-5h4v5"]);
export const Coins = make(["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M14.5 9.5c-.4-.9-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2.1-.6-2.5-1.5", "M12 6.5V8", "M12 16v1.5"]);
export const Book = make(["M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z", "M4 19a2 2 0 0 1 2-2h13", "M9 7h6"]);
