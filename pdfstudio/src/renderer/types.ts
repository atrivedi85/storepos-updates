export interface Box { x: number; y: number; w: number; h: number }

export type FontKey = 'helv' | 'times' | 'courier';

interface Base { id: string }
export interface MarkupObj extends Base { type: 'markup'; kind: 'highlight' | 'underline' | 'strike'; color: string; rects: Box[] }
export interface InkObj extends Base { type: 'ink'; x: number; y: number; w: number; h: number; pts: [number, number][]; color: string; width: number }
export interface ShapeObj extends Base {
  type: 'shape'; shape: 'rect' | 'ellipse' | 'line' | 'arrow';
  x: number; y: number; w: number; h: number;
  /** line/arrow endpoints, normalized to the bbox (0..1) */
  l: [number, number, number, number];
  stroke: string; fill: string; width: number;
}
export interface NoteObj extends Base { type: 'note'; x: number; y: number; w: number; h: number; text: string; color: string }
export interface TextObj extends Base {
  type: 'text'; x: number; y: number; w: number; h: number; text: string;
  size: number; color: string; font: FontKey; bold: boolean; italic: boolean;
  /** used by "edit existing text": opaque rectangle covering the original text */
  cover?: Box & { color: string };
  /** "edit existing text": the document's own font, reused when saving so the font does not change.
   *  name = font name as pdf.js reports it, css = pdf.js on-screen font family, chars = letters seen on the page in that font */
  orig?: { name: string; css: string; chars: string };
}
export interface ImageObj extends Base { type: 'image'; x: number; y: number; w: number; h: number; asset: string }
export interface FieldObj extends Base {
  type: 'field'; kind: 'text' | 'check' | 'dropdown'; name: string;
  x: number; y: number; w: number; h: number; options: string[]; fontSize: number; multiline: boolean;
}
export interface EraseObj extends Base { type: 'erase'; x: number; y: number; w: number; h: number; color: string; removeAnnots: boolean }
export type Obj = EraseObj | MarkupObj | InkObj | ShapeObj | NoteObj | TextObj | ImageObj | FieldObj;

export type ObjectsByPage = Record<number, Obj[]>;

export interface Asset { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; url: string }

export interface Snapshot {
  bytes: Uint8Array;
  objects: string;
  formValues: string;
}

export interface PageInfo { w: number; h: number; rotation: number }

export type ToolName =
  | 'select' | 'highlight' | 'underline' | 'strike' | 'draw' | 'shape' | 'note' | 'textbox'
  | 'edittext' | 'field' | 'place' | 'erase';

export type FormValue = string | boolean;

export interface FormFieldInfo {
  name: string; type: 'text' | 'check' | 'radio' | 'dropdown' | 'list' | 'button';
  page: number; rect: Box; options: string[]; value: FormValue; multiline: boolean;
  fontSize: number; radioValue?: string; readOnly: boolean;
}
