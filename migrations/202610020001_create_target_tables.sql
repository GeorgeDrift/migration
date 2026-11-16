-- Create "researchee_auth_table" table
CREATE TABLE `researchee_auth_table` (
  `researchee_id` int NOT NULL AUTO_INCREMENT,
  `researchee_email` varchar(100) NOT NULL,
  `researchee_password` varchar(50) NOT NULL,
  `created_at` timestamp NULL DEFAULT (current_timestamp()),
  PRIMARY KEY (`researchee_id`),
  UNIQUE INDEX `researchee_email` (`researchee_email`)
) CHARSET latin1 COLLATE latin1_swedish_ci;
-- Create "team" table
CREATE TABLE `team` (
  `team_id` int NOT NULL AUTO_INCREMENT,
  `team_name` varchar(50) NOT NULL,
  PRIMARY KEY (`team_id`)
) CHARSET latin1 COLLATE latin1_swedish_ci;
-- Create "experiment" table
CREATE TABLE `experiment` (
  `experiment_id` int NOT NULL AUTO_INCREMENT,
  `researcher_logincode` longtext NOT NULL,
  `experiment_name` longtext NOT NULL,
  `experiment_organisation` longtext NOT NULL,
  `experiment_researcher` varchar(200) NOT NULL,
  `experiment_study_info` longtext NOT NULL,
  `experiment_date_range` varchar(100) NOT NULL,
  `team_id` int NOT NULL,
  `has_rolling_dates` bool NOT NULL DEFAULT 0,
  `experiment_variables` json NOT NULL,
  `experiment_permissions` longtext NULL,
  `version` varchar(20) NOT NULL DEFAULT '1.0',
  `owner_id` int NULL,
  `updated_at` timestamp NULL DEFAULT (current_timestamp()) ON UPDATE current_timestamp(),
  `adjust_to_timezone` bool NOT NULL DEFAULT 0,
  PRIMARY KEY (`experiment_id`),
  UNIQUE INDEX `researcher_logincode` USING HASH (`researcher_logincode`),
  INDEX `team_id` (`team_id`),
  CONSTRAINT `experiment_ibfk_1` FOREIGN KEY (`team_id`) REFERENCES `team` (`team_id`) ON UPDATE RESTRICT ON DELETE CASCADE
) CHARSET latin1 COLLATE latin1_swedish_ci;
-- Create "study" table
CREATE TABLE `study` (
  `study_id` int NOT NULL AUTO_INCREMENT,
  `experiment_id` int NOT NULL,
  `study_name` varchar(50) NOT NULL,
  `daily_goal` int NOT NULL,
  `weekly_goal` int NOT NULL,
  `start_date` varchar(30) NULL,
  `end_date` varchar(30) NULL,
  `from_day` varchar(30) NULL,
  `to_day` varchar(30) NULL,
  `diary_incentive` double NOT NULL DEFAULT 0.00,
  `bonus_amount` double NOT NULL DEFAULT 0.00,
  `bonus_threshold` int NOT NULL DEFAULT 0,
  `is_fixed` tinyint NOT NULL DEFAULT 0,
  PRIMARY KEY (`study_id`),
  INDEX `study_ibfk_1` (`experiment_id`),
  CONSTRAINT `study_ibfk_1` FOREIGN KEY (`experiment_id`) REFERENCES `experiment` (`experiment_id`) ON UPDATE RESTRICT ON DELETE CASCADE
) CHARSET latin1 COLLATE latin1_swedish_ci;
-- Create "diaries" table
CREATE TABLE `diaries` (
  `diary_id` int NOT NULL AUTO_INCREMENT,
  `diary_name` varchar(50) NOT NULL,
  `study_id` int NOT NULL,
  `start_time` varchar(255) NOT NULL,
  `end_time` varchar(255) NOT NULL,
  `entries` int NOT NULL,
  `active_days` longtext CHARSET utf8mb4 NOT NULL COLLATE utf8mb4_bin,
  `frequency` varchar(255) NOT NULL,
  `service` varchar(100) NULL,
  PRIMARY KEY (`diary_id`),
  INDEX `study_id` (`study_id`),
  CONSTRAINT `diaries_ibfk_1` FOREIGN KEY (`study_id`) REFERENCES `study` (`study_id`) ON UPDATE RESTRICT ON DELETE CASCADE
) CHARSET latin1 COLLATE latin1_swedish_ci;
-- Create "diary_notifications" table
CREATE TABLE `diary_notifications` (
  `notification_id` int NOT NULL AUTO_INCREMENT,
  `diary_id` int NOT NULL,
  `title` varchar(255) NOT NULL,
  `subtitle` varchar(255) NOT NULL,
  `time` varchar(200) NOT NULL,
  `cancellable` bool NULL DEFAULT 0,
  PRIMARY KEY (`notification_id`),
  INDEX `diary_id` (`diary_id`),
  CONSTRAINT `diary_notifications_ibfk_1` FOREIGN KEY (`diary_id`) REFERENCES `diaries` (`diary_id`) ON UPDATE RESTRICT ON DELETE CASCADE
) CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Create "experiment_onboarding_questions" table
CREATE TABLE `experiment_onboarding_questions` (
  `onboarding_question_id` int NOT NULL AUTO_INCREMENT,
  `experiment_id` int NOT NULL,
  `type_` varchar(50) NOT NULL,
  `title` varchar(1000) NOT NULL,
  `subtitle` varchar(1000) NULL,
  `required` bool NULL DEFAULT 1,
  `max_value` int NULL,
  `min_value` int NULL,
  `default_value` int NULL,
  `question_number` varchar(255) NULL,
  `option_text` varchar(1000) NULL,
  `variable` varchar(1000) NOT NULL,
  `max_label` varchar(255) NULL,
  `min_label` varchar(255) NULL,
  PRIMARY KEY (`onboarding_question_id`),
  INDEX `experiment_id` (`experiment_id`),
  CONSTRAINT `experiment_onboarding_questions_ibfk_1` FOREIGN KEY (`experiment_id`) REFERENCES `experiment` (`experiment_id`) ON UPDATE RESTRICT ON DELETE CASCADE
) CHARSET latin1 COLLATE latin1_swedish_ci;
-- Create "questions" table
CREATE TABLE `questions` (
  `question_id` int NOT NULL AUTO_INCREMENT,
  `diary_id` int NOT NULL,
  `title` varchar(2000) NOT NULL,
  `subtitle` varchar(2000) NULL,
  `required` bool NOT NULL,
  `question_number` varchar(255) NULL,
  `is_shared` bool NULL DEFAULT 0,
  `question_body_json` longtext NOT NULL DEFAULT '{}',
  PRIMARY KEY (`question_id`),
  INDEX `diary_id` (`diary_id`),
  CONSTRAINT `questions_ibfk_1` FOREIGN KEY (`diary_id`) REFERENCES `diaries` (`diary_id`) ON UPDATE RESTRICT ON DELETE CASCADE
) CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Create "study_notifications" table
CREATE TABLE `study_notifications` (
  `notification_id` int NOT NULL AUTO_INCREMENT,
  `study_id` int NOT NULL,
  `title` varchar(255) NOT NULL,
  `subtitle` varchar(255) NOT NULL,
  `time` varchar(200) NOT NULL,
  `cancellable` bool NULL DEFAULT 0,
  PRIMARY KEY (`notification_id`),
  INDEX `study_id` (`study_id`),
  CONSTRAINT `study_notifications_ibfk_1` FOREIGN KEY (`study_id`) REFERENCES `study` (`study_id`) ON UPDATE RESTRICT ON DELETE CASCADE
) CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Create "user" table
CREATE TABLE `user` (
  `user_id` int NOT NULL AUTO_INCREMENT,
  `studycode` varchar(50) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT (current_timestamp()),
  `experimentid` int NOT NULL,
  `extra` json NULL,
  `variable_questions` json NULL,
  `user_token` varchar(2000) NULL,
  `service` varchar(100) NULL,
  `updated_at` timestamp NULL DEFAULT (current_timestamp()) ON UPDATE current_timestamp(),
  PRIMARY KEY (`user_id`),
  INDEX `user_experiment_FK` (`experimentid`),
  CONSTRAINT `user_experiment_FK` FOREIGN KEY (`experimentid`) REFERENCES `experiment` (`experiment_id`) ON UPDATE CASCADE ON DELETE CASCADE
) CHARSET latin1 COLLATE latin1_swedish_ci;
-- Create "user_diary_version" table
CREATE TABLE `user_diary_version` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT (current_timestamp()),
  `diary_changes` json NULL,
  `diary_version_map` json NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_user_diary_user` (`user_id`),
  CONSTRAINT `fk_user_diary_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON UPDATE CASCADE ON DELETE CASCADE
) CHARSET utf8mb4 COLLATE utf8mb4_general_ci AUTO_INCREMENT 43;
-- Create "user_on_question" table
CREATE TABLE `user_on_question` (
  `user_on_question_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `question_id` int NOT NULL,
  `is_disabled` bool NOT NULL DEFAULT 0,
  `is_user_specific` bool NOT NULL DEFAULT 0,
  `experiment_id` int NOT NULL,
  PRIMARY KEY (`user_on_question_id`),
  INDEX `experiment_id` (`experiment_id`),
  INDEX `question_id` (`question_id`),
  INDEX `user_id` (`user_id`),
  CONSTRAINT `user_on_question_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT `user_on_question_ibfk_2` FOREIGN KEY (`question_id`) REFERENCES `questions` (`question_id`) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT `user_on_question_ibfk_3` FOREIGN KEY (`experiment_id`) REFERENCES `experiment` (`experiment_id`) ON UPDATE RESTRICT ON DELETE CASCADE
) CHARSET latin1 COLLATE latin1_swedish_ci;
