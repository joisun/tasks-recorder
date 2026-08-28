"use client";

import type * as React from "react";
import { composeRenderProps } from "react-aria-components/composeRenderProps";
import * as SearchFieldPrimitives from "react-aria-components/SearchField";

import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { fieldStyles as useStyles } from "@/components/ui/field";
import { Input, InputGroup, InputGroupAddon } from "@/components/ui/input";
import type { InputGroupProps } from "@/components/ui/input";

interface SearchFieldProps extends React.ComponentProps<
  typeof SearchFieldPrimitives.SearchField
> {
  placeholder?: string;
  size?: InputGroupProps["size"];
}

const SearchField = ({
  className,
  placeholder,
  size,
  ...props
}: SearchFieldProps) => {
  const fieldStyles = useStyles();
  return (
    <SearchFieldPrimitives.SearchField
      data-search-field=""
      data-slot="search-field"
      className={composeRenderProps(className, (className) =>
        cn(
          fieldStyles.field({ className }),
          "group/search-field empty:**:data-input-group-addon:*:data-button:not-[[slot]]:hidden **:data-input:[&::-webkit-search-cancel-button]:appearance-none **:data-input:[&::-webkit-search-decoration]:appearance-none",
        ),
      )}
      {...props}
    >
      {props?.children ?? (
        <InputGroup size={size}>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <Input placeholder={placeholder} />
        </InputGroup>
      )}
    </SearchFieldPrimitives.SearchField>
  );
};

export type { SearchFieldProps };
export { SearchField };
