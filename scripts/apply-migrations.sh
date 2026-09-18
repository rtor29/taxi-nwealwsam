#!/usr/bin/env bash
# =============================================================================
# Taxi-Wisam: Supabase Migration & Deployment Script
# Project Ref: zterexrspluhomwgdjzp
# =============================================================================

set -e

PROJECT_REF="zterexrspluhomwgdjzp"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "========================================================"
echo " Taxi-Wisam Supabase Migration Runner"
echo " Project Ref: $PROJECT_REF"
echo "========================================================"

if command -v supabase &> /dev/null; then
    echo " Supabase CLI detected."
    cd "$ROOT_DIR"
    
    echo "--> Linking project $PROJECT_REF..."
    supabase link --project-ref "$PROJECT_REF"
    
    echo "--> Pushing migrations to remote Supabase database..."
    supabase db push
    
    echo " Successfully applied all migrations to Supabase!"
else
    echo "[!] Supabase CLI not found. If you have psql and your DB connection string, you can run:"
    echo "    export DB_URL='postgresql://postgres:[YOUR-PASSWORD]@db.zterexrspluhomwgdjzp.supabase.co:5432/postgres'"
    echo "    psql \"\$DB_URL\" -f $ROOT_DIR/supabase/migrations/20260917000001_initial_schema.sql"
    echo "    psql \"\$DB_URL\" -f $ROOT_DIR/supabase/migrations/20260917000002_spatial_functions.sql"
    echo "    psql \"\$DB_URL\" -f $ROOT_DIR/supabase/migrations/20260917000003_storage_buckets.sql"
    echo "    psql \"\$DB_URL\" -f $ROOT_DIR/supabase/migrations/20260917000004_seed_data.sql"
fi
