-- ============================================================
-- Migration manuelle : support du "Direct Upload" vidéo Cloudinary
-- À exécuter dans l'éditeur SQL Supabase, ou via psql :
--   psql "$DATABASE_URL" -f scripts/add-video-url.sql
--
-- Inutile si vous relancez simplement le serveur : la fonction
-- runMigrations() de server/db.js applique déjà cette même colonne
-- automatiquement au démarrage (idempotent, sans perte de données).
-- Ce script sert uniquement si vous préférez l'appliquer à la main
-- avant le prochain déploiement.
-- ============================================================

ALTER TABLE photos ADD COLUMN IF NOT EXISTS video_url TEXT;

-- Vérification :
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'photos' AND column_name = 'video_url';
