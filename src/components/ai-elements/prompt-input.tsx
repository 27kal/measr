"use client";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatStatus } from "ai";
import { CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import type { ComponentProps, FormEvent, HTMLAttributes } from "react";
import { useCallback } from "react";

export interface PromptInputMessage {
  text: string;
  files: [];
}

export type PromptInputProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => {
  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await onSubmit({ text: String(formData.get("message") ?? ""), files: [] }, event);
  }, [onSubmit]);

  return <form className={cn("w-full", className)} onSubmit={handleSubmit} {...props}>
    <InputGroup className="overflow-hidden">{children}</InputGroup>
  </form>;
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;
export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => <div className={cn("contents", className)} {...props} />;

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;
export const PromptInputTextarea = ({ className, onKeyDown, ...props }: PromptInputTextareaProps) => <InputGroupTextarea
  className={cn("field-sizing-content max-h-48 min-h-16", className)}
  name="message"
  onKeyDown={event => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }}
  {...props}
/>;

export type PromptInputFooterProps = ComponentProps<typeof InputGroupAddon>;
export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => <InputGroupAddon align="block-end" className={cn("justify-between gap-1", className)} {...props} />;

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & { status?: ChatStatus; onStop?: () => void };
export const PromptInputSubmit = ({ className, status, onStop, onClick, children, ...props }: PromptInputSubmitProps) => {
  const generating = status === "submitted" || status === "streaming";
  const icon = status === "submitted" ? <Spinner /> : status === "streaming" ? <SquareIcon className="size-4" /> : status === "error" ? <XIcon className="size-4" /> : <CornerDownLeftIcon className="size-4" />;
  return <InputGroupButton
    aria-label={generating ? "Stop" : "Submit"}
    className={cn(className)}
    onClick={event => {
      if (generating && onStop) { event.preventDefault(); onStop(); return; }
      onClick?.(event);
    }}
    size="icon-sm"
    type={generating && onStop ? "button" : "submit"}
    {...props}
  >{children ?? icon}</InputGroupButton>;
};
