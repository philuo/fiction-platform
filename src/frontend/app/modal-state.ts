export type ModalId = "gacha" | "settings" | "memory" | "brain" | "tasks" | "foreshadow" | "eval" | "integrity" | "portrait" | "auto" | "relationship";

export type ModalState = {
  open: ModalId | null;
  settingsTab?: string;
  relationship?: { editable: boolean; charId: string | null };
};

export type ModalAction =
  | { type: "open"; modal: ModalId; settingsTab?: string }
  | { type: "open-relationship"; editable: boolean; charId: string | null }
  | { type: "close" }
  | { type: "reset" };

export const initialModalState: ModalState = { open: null };

export function modalReducer(state: ModalState, action: ModalAction): ModalState {
  switch (action.type) {
    case "open": return { open: action.modal, settingsTab: action.settingsTab };
    case "open-relationship": return { open: "relationship", relationship: { editable: action.editable, charId: action.charId } };
    case "close": return initialModalState;
    case "reset": return initialModalState;
  }
}
