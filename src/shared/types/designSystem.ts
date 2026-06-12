/**
 * Shared design-system types describing existing MaxView screens.
 * Sourced from the MaxView `clientapp-screens.md` inventory (Route → Component/File → Purpose).
 */

/** A single existing MaxView screen, used to populate route pickers and drive route inference. */
export interface ScreenInventoryRoute {
  /** Route path of the existing page, e.g. "/timecards". */
  route: string;
  /** Component or source file backing the page, e.g. "TimecardsView.tsx". */
  file?: string;
  /** One-line purpose/description of the page. */
  purpose?: string;
  /** Persona slugs the screen is for (from the inventory "User types" column), e.g. ["S","I","C"]. */
  userTypes?: string[];
  /** Free-text states summary for the screen (from the inventory "States" column). */
  states?: string;
  /** Key sub-components/primitives used by the page (from the inventory "Key components" column). */
  keyComponents?: string[];
}
