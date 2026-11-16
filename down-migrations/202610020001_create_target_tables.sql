-- Reverse of 202610020001_create_target_tables.sql: drops the baseline tables, children first.
-- Every row in these tables is lost. Use only on a target whose data is disposable or backed up.
DROP TABLE `user_on_question`;
DROP TABLE `user_diary_version`;
DROP TABLE `user`;
DROP TABLE `study_notifications`;
DROP TABLE `questions`;
DROP TABLE `experiment_onboarding_questions`;
DROP TABLE `diary_notifications`;
DROP TABLE `diaries`;
DROP TABLE `study`;
DROP TABLE `experiment`;
DROP TABLE `team`;
DROP TABLE `researchee_auth_table`;
