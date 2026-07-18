import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  group: string;
}

export function Select({
  value,
  onValueChange,
  options,
  label,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  disabled?: boolean;
}) {
  const groups = new Map<string, SelectOption[]>();
  for (const option of options) {
    const group = groups.get(option.group) ?? [];
    group.push(option);
    groups.set(option.group, group);
  }
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger className="select-trigger" aria-label={label}>
        <span className="select-value">
          <SelectPrimitive.Value />
        </span>
        <SelectPrimitive.Icon aria-hidden="true">
          <ChevronDown size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="select-content"
          position="popper"
          sideOffset={8}
        >
          <SelectPrimitive.Viewport className="select-viewport">
            {Array.from(groups, ([group, items]) => (
              <SelectPrimitive.Group key={group}>
                <SelectPrimitive.Label className="select-label">
                  {group}
                </SelectPrimitive.Label>
                {items.map((option) => (
                  <SelectPrimitive.Item
                    key={option.value}
                    value={option.value}
                    className="select-item"
                  >
                    <SelectPrimitive.ItemText>
                      {option.label}
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator aria-hidden="true">
                      <Check size={15} />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Group>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
