-- Run this ONCE, after schema.sql, to make the first owner.
-- 1. In the Clerk dashboard create the owner's user (Users > Create user), then copy the user id (starts with user_).
-- 2. Replace the three values below and run it in the Supabase SQL Editor.
-- Without this row nobody can use the app (an unknown login gets "No access yet").
insert into public.profiles (clerk_user_id, full_name, login_name, role)
values ('user_PASTE_THE_CLERK_USER_ID_HERE', 'Owner Full Name', 'owner-login-name', 'owner');
