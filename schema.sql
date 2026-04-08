-- ARG Phase 2 Database Schema
-- Run this once on your MySQL server

CREATE DATABASE IF NOT EXISTS arg_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE arg_db;

-- Clients table
CREATE TABLE IF NOT EXISTS clients (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  cin VARCHAR(25) DEFAULT '',
  filing_type ENUM('first','repeat') DEFAULT 'first',
  prev_report_available TINYINT(1) DEFAULT 0,
  has_subsidiaries TINYINT(1) DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  added_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Per-client, per-FY status tracking
CREATE TABLE IF NOT EXISTS client_fy_data (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(50) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  report_status ENUM('not-started','uploaded','checklist-done','generated','draft','complete') DEFAULT 'not-started',
  deadline DATE DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE KEY uq_client_fy (client_id, financial_year)
);

-- Uploaded files per client per FY
CREATE TABLE IF NOT EXISTS uploads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(50) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  upload_type ENUM(
    'schedule3',
    'prev_annual_report',
    'subsidiary_schedule3',
    'cfs',
    'finalized_report'
  ) NOT NULL,
  original_filename VARCHAR(255),
  stored_filename VARCHAR(255),
  file_path VARCHAR(500),
  file_size INT DEFAULT 0,
  mime_type VARCHAR(100),
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

-- Checklist answers per client per FY (stored as JSON)
CREATE TABLE IF NOT EXISTS checklist_data (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(50) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  answers_json LONGTEXT,
  imported_from_excel TINYINT(1) DEFAULT 0,
  confirmed TINYINT(1) DEFAULT 0,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE KEY uq_client_fy_cl (client_id, financial_year)
);

-- Report metadata per client per FY
CREATE TABLE IF NOT EXISTS reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(50) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  report_type ENUM('standalone','standalone_holding','standalone_subsidiary','consolidated') DEFAULT 'standalone',
  current_version INT DEFAULT 0,
  status ENUM('draft','complete') DEFAULT 'draft',
  is_finalized TINYINT(1) DEFAULT 0,
  finalized_file_path VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE KEY uq_client_fy_type (client_id, financial_year, report_type)
);

-- Every version of every report — full audit trail
CREATE TABLE IF NOT EXISTS report_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  report_id INT NOT NULL,
  version_number INT NOT NULL,
  version_label VARCHAR(100),
  content LONGTEXT,
  word_file_path VARCHAR(500) DEFAULT NULL,
  pdf_file_path VARCHAR(500) DEFAULT NULL,
  action_type ENUM(
    'ai_generated',
    'manual_edit',
    'regenerated_full',
    'regenerated_figures',
    'marked_complete',
    'reopened',
    'finalized_uploaded'
  ) DEFAULT 'ai_generated',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

-- AI memory per client (carries forward year to year)
CREATE TABLE IF NOT EXISTS client_memory (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(50) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  memory_json LONGTEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE KEY uq_client_fy_mem (client_id, financial_year)
);

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(50) DEFAULT NULL,
  financial_year VARCHAR(10) DEFAULT NULL,
  action_text VARCHAR(500),
  action_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
