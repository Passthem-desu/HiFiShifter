/**
 * 通用加载动画组件 (Task 6.1)
 *
 * 支持不同尺寸和颜色的 Spinner
 */

import React from "react";

export interface LoadingSpinnerProps {
    size?: "sm" | "md" | "lg";
    color?: string;
    className?: string;
}

const sizeClasses = {
    sm: "w-4 h-4 border-2",
    md: "w-6 h-6 border-2",
    lg: "w-8 h-8 border-3",
};

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
    size = "md",
    color = "currentColor",
    className = "",
}) => {
    const sizeClass = sizeClasses[size];

    return (
        <div
            className={`inline-block animate-spin rounded-full border-solid border-t-transparent ${sizeClass} ${className}`}
            style={{
                borderColor: color,
                borderTopColor: "transparent",
            }}
            role="status"
            aria-label="Loading"
        >
            <span className="sr-only">Loading...</span>
        </div>
    );
};
