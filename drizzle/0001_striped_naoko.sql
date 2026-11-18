PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`department_id` text,
	`agent_id` text,
	`api_key_id` text,
	`user_label` text NOT NULL,
	`provider_type` text NOT NULL,
	`model_used` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`actual_cost_usd` real,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_usage_logs`("id", "workspace_id", "department_id", "agent_id", "api_key_id", "user_label", "provider_type", "model_used", "status", "error_code", "error_message", "input_tokens", "output_tokens", "actual_cost_usd", "latency_ms", "created_at") SELECT "id", "workspace_id", "department_id", "agent_id", "api_key_id", "user_label", "provider_type", "model_used", "status", "error_code", "error_message", "input_tokens", "output_tokens", "actual_cost_usd", "latency_ms", "created_at" FROM `usage_logs`;--> statement-breakpoint
DROP TABLE `usage_logs`;--> statement-breakpoint
ALTER TABLE `__new_usage_logs` RENAME TO `usage_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `usage_logs_workspace_created_idx` ON `usage_logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_logs_dept_created_idx` ON `usage_logs` (`department_id`,`created_at`);