'use client'

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { type VariantProps } from 'class-variance-authority'
import { buttonVariants } from '@/components/ui/button'

interface DropdownOption {
  value: string
  label: string
  subLabel?: string
  icon?: React.ReactNode
}

interface DropdownButtonProps extends VariantProps<typeof buttonVariants> {
  options: DropdownOption[]
  onAction: (selectedValue: string) => void
  disabled?: boolean
  className?: string
  mainIcon?: React.ReactNode
  defaultSelectedValue?: string
  mainButtonText?: string
  buttonClassName?: string
  dropdownClassName?: string
}

export function DropdownButton({
  options,
  onAction,
  disabled = false,
  className,
  mainIcon,
  defaultSelectedValue,
  mainButtonText = 'Add',
  variant = 'default',
  size = 'sm',
  buttonClassName,
  dropdownClassName
}: DropdownButtonProps) {
  const [selectedValue, setSelectedValue] = useState<string>(defaultSelectedValue || options[0]?.value || '')
  
  const selectedOption = options.find(option => option.value === selectedValue) || options[0]

  const handleButtonClick = () => {
    onAction(selectedValue)
  }

  const handleOptionSelect = (value: string) => {
    setSelectedValue(value)
  }

  return (
    <div className={cn("inline-flex", className)}>
      {/* Main button with selected option display */}
      <div className="flex items-stretch rounded-md overflow-hidden">
        <Button
          onClick={handleButtonClick}
          disabled={disabled}
          variant={variant}
          size={size}
          className={cn(
            "rounded-none border-r flex items-center min-w-[80px]",
            variant === 'outline' ? "border-r-input" : "border-r-gray-600",
            buttonClassName
          )}
        >
          {mainIcon && <span className="mr-1">{mainIcon}</span>}
          {mainButtonText}
        </Button>

        {/* Selected option display */}
        {selectedOption.subLabel && (
          <div
            className={cn(
              "flex items-center px-2 text-xs transition-opacity",
              variant === 'outline'
                ? "bg-background border-y border-input text-foreground"
                : "bg-primary text-primary-foreground",
              size === 'sm' ? "h-8" : size === 'lg' ? "h-10" : "h-9",
              disabled && "opacity-50"
            )}
          >
            {selectedOption.subLabel}
          </div>
        )}

        {/* Dropdown trigger */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              disabled={disabled}
              variant={variant}
              size={size}
              className={cn(
                "rounded-none px-2",
                !selectedOption.subLabel && "border-l",
                variant === 'outline' && !selectedOption.subLabel && "border-l-input",
                dropdownClassName
              )}
            >
              <span className="flex items-center justify-center w-3 h-3">
                {selectedOption.icon || <ChevronDown className="w-3 h-3" />}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={cn("w-48", variant === 'outline' && "bg-background")}>
            {options.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => handleOptionSelect(option.value)}
                className={cn(
                  "cursor-pointer",
                  selectedValue === option.value && (variant === 'outline' ? "bg-accent" : "bg-gray-100")
                )}
              >
                <div className="flex items-center text-xs py-0.5">
                  {option.icon && <span className="mr-1">{option.icon}</span>}
                  <span>{option.label}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
