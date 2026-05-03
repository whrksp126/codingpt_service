--
-- PostgreSQL database dump
--


-- Dumped from database version 15.17
-- Dumped by pg_dump version 15.17

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: class; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.class (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255) NOT NULL
);


--
-- Name: class_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.class_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: class_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.class_id_seq OWNED BY public.class.id;


--
-- Name: class_section_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.class_section_map (
    class_id integer NOT NULL,
    section_id integer NOT NULL
);


--
-- Name: code_fill_gap; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.code_fill_gap (
    id integer NOT NULL,
    content text NOT NULL,
    slide_id integer NOT NULL
);


--
-- Name: code_fill_gap_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.code_fill_gap_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: code_fill_gap_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.code_fill_gap_id_seq OWNED BY public.code_fill_gap.id;


--
-- Name: curriculum; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curriculum (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255) NOT NULL
);


--
-- Name: curriculum_class_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curriculum_class_map (
    curriculum_id integer NOT NULL,
    class_id integer NOT NULL
);


--
-- Name: curriculum_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.curriculum_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: curriculum_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.curriculum_id_seq OWNED BY public.curriculum.id;


--
-- Name: lesson; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lesson (
    id integer NOT NULL,
    order_no integer NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(255) NOT NULL,
    description character varying(255)
);


--
-- Name: lesson_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lesson_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lesson_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lesson_id_seq OWNED BY public.lesson.id;


--
-- Name: lesson_slide_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lesson_slide_map (
    lesson_id integer NOT NULL,
    slide_id integer NOT NULL
);


--
-- Name: myclass; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.myclass (
    id integer NOT NULL,
    user_id integer NOT NULL,
    product_id integer NOT NULL
);


--
-- Name: myclass_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.myclass_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: myclass_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.myclass_id_seq OWNED BY public.myclass.id;


--
-- Name: myclass_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.myclass_status (
    id integer NOT NULL,
    myclass_id integer NOT NULL,
    lesson_id integer NOT NULL,
    status integer DEFAULT 1 NOT NULL,
    results json NOT NULL
);


--
-- Name: myclass_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.myclass_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: myclass_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.myclass_status_id_seq OWNED BY public.myclass_status.id;


--
-- Name: product; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255) NOT NULL,
    type character varying(255) NOT NULL,
    price integer DEFAULT 0 NOT NULL,
    lecture_intro json,
    category character varying(255),
    difficulty character varying(255)
);


--
-- Name: product_class_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_class_map (
    product_id integer NOT NULL,
    class_id integer NOT NULL
);


--
-- Name: product_curriculum_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_curriculum_map (
    id integer NOT NULL,
    product_id integer NOT NULL,
    curriculum_id integer NOT NULL
);


--
-- Name: product_curriculum_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_curriculum_map_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_curriculum_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_curriculum_map_id_seq OWNED BY public.product_curriculum_map.id;


--
-- Name: product_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_id_seq OWNED BY public.product.id;


--
-- Name: product_relatedproduct_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_relatedproduct_map (
    id integer NOT NULL,
    product_id integer NOT NULL,
    relatedproduct_id integer NOT NULL
);


--
-- Name: product_relatedproduct_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_relatedproduct_map_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_relatedproduct_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_relatedproduct_map_id_seq OWNED BY public.product_relatedproduct_map.id;


--
-- Name: product_review_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_review_map (
    product_id integer NOT NULL,
    review_id integer NOT NULL
);


--
-- Name: review; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review (
    id integer NOT NULL,
    user_id integer NOT NULL,
    score integer NOT NULL,
    review_text character varying(255) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone
);


--
-- Name: review_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_id_seq OWNED BY public.review.id;


--
-- Name: section; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.section (
    id integer NOT NULL,
    order_no integer NOT NULL,
    name character varying(255) NOT NULL,
    doc_concept json NOT NULL
);


--
-- Name: section_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.section_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: section_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.section_id_seq OWNED BY public.section.id;


--
-- Name: section_lesson_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.section_lesson_map (
    section_id integer NOT NULL,
    lesson_id integer NOT NULL
);


--
-- Name: slide; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slide (
    id integer NOT NULL,
    contents json NOT NULL
);


--
-- Name: slide_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.slide_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: slide_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.slide_id_seq OWNED BY public.slide.id;


--
-- Name: storecategory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storecategory (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255) NOT NULL
);


--
-- Name: storecategory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storecategory_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storecategory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storecategory_id_seq OWNED BY public.storecategory.id;


--
-- Name: storecategory_product_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storecategory_product_map (
    category_id integer NOT NULL,
    product_id integer NOT NULL
);


--
-- Name: study_heatmap_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.study_heatmap_log (
    id integer NOT NULL,
    user_id integer NOT NULL,
    product_id integer NOT NULL,
    section_id integer NOT NULL,
    lesson_id integer NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: study_heatmap_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.study_heatmap_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: study_heatmap_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.study_heatmap_log_id_seq OWNED BY public.study_heatmap_log.id;


--
-- Name: tts_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tts_requests (
    id integer NOT NULL,
    user_id integer,
    voice_id character varying(100),
    model_id character varying(50),
    text text NOT NULL,
    text_with_emotions text,
    settings jsonb,
    audio_url text,
    audio_s3_path text,
    timestamps jsonb,
    file_name character varying(500),
    file_size integer,
    duration double precision,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    is_saved boolean DEFAULT false NOT NULL,
    s3_save_path text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: tts_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tts_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tts_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tts_requests_id_seq OWNED BY public.tts_requests.id;


--
-- Name: tts_saved_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tts_saved_files (
    id integer NOT NULL,
    user_id integer NOT NULL,
    tts_request_id integer,
    s3_path text NOT NULL,
    file_name character varying(500) NOT NULL,
    original_text text NOT NULL,
    voice_id character varying(100),
    model_id character varying(50),
    settings jsonb,
    timestamps jsonb,
    file_size integer,
    duration double precision,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: tts_saved_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tts_saved_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tts_saved_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tts_saved_files_id_seq OWNED BY public.tts_saved_files.id;


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    google_id character varying(255) NOT NULL,
    refresh_token character varying(255),
    created_at timestamp with time zone NOT NULL,
    profile_img character varying(255),
    nickname character varying(255) NOT NULL,
    xp integer DEFAULT 0 NOT NULL,
    heart integer DEFAULT 5 NOT NULL,
    heart_missing integer DEFAULT 0 NOT NULL,
    hearts_refill_started_at timestamp with time zone
);


--
-- Name: user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_id_seq OWNED BY public."user".id;


--
-- Name: class id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class ALTER COLUMN id SET DEFAULT nextval('public.class_id_seq'::regclass);


--
-- Name: code_fill_gap id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_fill_gap ALTER COLUMN id SET DEFAULT nextval('public.code_fill_gap_id_seq'::regclass);


--
-- Name: curriculum id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum ALTER COLUMN id SET DEFAULT nextval('public.curriculum_id_seq'::regclass);


--
-- Name: lesson id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson ALTER COLUMN id SET DEFAULT nextval('public.lesson_id_seq'::regclass);


--
-- Name: myclass id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.myclass ALTER COLUMN id SET DEFAULT nextval('public.myclass_id_seq'::regclass);


--
-- Name: myclass_status id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.myclass_status ALTER COLUMN id SET DEFAULT nextval('public.myclass_status_id_seq'::regclass);


--
-- Name: product id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product ALTER COLUMN id SET DEFAULT nextval('public.product_id_seq'::regclass);


--
-- Name: product_curriculum_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_curriculum_map ALTER COLUMN id SET DEFAULT nextval('public.product_curriculum_map_id_seq'::regclass);


--
-- Name: product_relatedproduct_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_relatedproduct_map ALTER COLUMN id SET DEFAULT nextval('public.product_relatedproduct_map_id_seq'::regclass);


--
-- Name: review id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review ALTER COLUMN id SET DEFAULT nextval('public.review_id_seq'::regclass);


--
-- Name: section id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section ALTER COLUMN id SET DEFAULT nextval('public.section_id_seq'::regclass);


--
-- Name: slide id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slide ALTER COLUMN id SET DEFAULT nextval('public.slide_id_seq'::regclass);


--
-- Name: storecategory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storecategory ALTER COLUMN id SET DEFAULT nextval('public.storecategory_id_seq'::regclass);


--
-- Name: study_heatmap_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_heatmap_log ALTER COLUMN id SET DEFAULT nextval('public.study_heatmap_log_id_seq'::regclass);


--
-- Name: tts_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_requests ALTER COLUMN id SET DEFAULT nextval('public.tts_requests_id_seq'::regclass);


--
-- Name: tts_saved_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_saved_files ALTER COLUMN id SET DEFAULT nextval('public.tts_saved_files_id_seq'::regclass);


--
-- Name: user id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user" ALTER COLUMN id SET DEFAULT nextval('public.user_id_seq'::regclass);


--
-- Name: class class_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class
    ADD CONSTRAINT class_pkey PRIMARY KEY (id);


--
-- Name: class_section_map class_section_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_section_map
    ADD CONSTRAINT class_section_map_pkey PRIMARY KEY (class_id, section_id);


--
-- Name: code_fill_gap code_fill_gap_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_fill_gap
    ADD CONSTRAINT code_fill_gap_pkey PRIMARY KEY (id);


--
-- Name: curriculum_class_map curriculum_class_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_class_map
    ADD CONSTRAINT curriculum_class_map_pkey PRIMARY KEY (curriculum_id, class_id);


--
-- Name: curriculum curriculum_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum
    ADD CONSTRAINT curriculum_pkey PRIMARY KEY (id);


--
-- Name: lesson lesson_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson
    ADD CONSTRAINT lesson_pkey PRIMARY KEY (id);


--
-- Name: lesson_slide_map lesson_slide_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_slide_map
    ADD CONSTRAINT lesson_slide_map_pkey PRIMARY KEY (lesson_id, slide_id);


--
-- Name: myclass myclass_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.myclass
    ADD CONSTRAINT myclass_pkey PRIMARY KEY (id);


--
-- Name: myclass_status myclass_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.myclass_status
    ADD CONSTRAINT myclass_status_pkey PRIMARY KEY (id);


--
-- Name: product_class_map product_class_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_class_map
    ADD CONSTRAINT product_class_map_pkey PRIMARY KEY (product_id, class_id);


--
-- Name: product_curriculum_map product_curriculum_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_curriculum_map
    ADD CONSTRAINT product_curriculum_map_pkey PRIMARY KEY (id);


--
-- Name: product product_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product
    ADD CONSTRAINT product_pkey PRIMARY KEY (id);


--
-- Name: product_relatedproduct_map product_relatedproduct_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_relatedproduct_map
    ADD CONSTRAINT product_relatedproduct_map_pkey PRIMARY KEY (id);


--
-- Name: product_review_map product_review_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_review_map
    ADD CONSTRAINT product_review_map_pkey PRIMARY KEY (product_id, review_id);


--
-- Name: review review_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review
    ADD CONSTRAINT review_pkey PRIMARY KEY (id);


--
-- Name: section_lesson_map section_lesson_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_lesson_map
    ADD CONSTRAINT section_lesson_map_pkey PRIMARY KEY (section_id, lesson_id);


--
-- Name: section section_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section
    ADD CONSTRAINT section_pkey PRIMARY KEY (id);


--
-- Name: slide slide_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slide
    ADD CONSTRAINT slide_pkey PRIMARY KEY (id);


--
-- Name: storecategory storecategory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storecategory
    ADD CONSTRAINT storecategory_pkey PRIMARY KEY (id);


--
-- Name: storecategory_product_map storecategory_product_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storecategory_product_map
    ADD CONSTRAINT storecategory_product_map_pkey PRIMARY KEY (category_id, product_id);


--
-- Name: study_heatmap_log study_heatmap_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_heatmap_log
    ADD CONSTRAINT study_heatmap_log_pkey PRIMARY KEY (id);


--
-- Name: tts_requests tts_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_requests
    ADD CONSTRAINT tts_requests_pkey PRIMARY KEY (id);


--
-- Name: tts_saved_files tts_saved_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_saved_files
    ADD CONSTRAINT tts_saved_files_pkey PRIMARY KEY (id);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: class_section_map class_section_map_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_section_map
    ADD CONSTRAINT class_section_map_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.class(id) ON UPDATE CASCADE;


--
-- Name: class_section_map class_section_map_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_section_map
    ADD CONSTRAINT class_section_map_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.section(id) ON UPDATE CASCADE;


--
-- Name: code_fill_gap code_fill_gap_slide_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_fill_gap
    ADD CONSTRAINT code_fill_gap_slide_id_fkey FOREIGN KEY (slide_id) REFERENCES public.slide(id) ON UPDATE CASCADE;


--
-- Name: curriculum_class_map curriculum_class_map_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_class_map
    ADD CONSTRAINT curriculum_class_map_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.class(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: curriculum_class_map curriculum_class_map_curriculum_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_class_map
    ADD CONSTRAINT curriculum_class_map_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.curriculum(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: lesson_slide_map lesson_slide_map_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_slide_map
    ADD CONSTRAINT lesson_slide_map_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lesson(id) ON UPDATE CASCADE;


--
-- Name: lesson_slide_map lesson_slide_map_slide_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_slide_map
    ADD CONSTRAINT lesson_slide_map_slide_id_fkey FOREIGN KEY (slide_id) REFERENCES public.slide(id) ON UPDATE CASCADE;


--
-- Name: myclass myclass_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.myclass
    ADD CONSTRAINT myclass_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON UPDATE CASCADE;


--
-- Name: myclass_status myclass_status_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.myclass_status
    ADD CONSTRAINT myclass_status_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lesson(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: myclass_status myclass_status_myclass_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.myclass_status
    ADD CONSTRAINT myclass_status_myclass_id_fkey FOREIGN KEY (myclass_id) REFERENCES public.myclass(id) ON UPDATE CASCADE;


--
-- Name: myclass myclass_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.myclass
    ADD CONSTRAINT myclass_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE;


--
-- Name: product_class_map product_class_map_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_class_map
    ADD CONSTRAINT product_class_map_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.class(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: product_class_map product_class_map_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_class_map
    ADD CONSTRAINT product_class_map_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: product_curriculum_map product_curriculum_map_curriculum_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_curriculum_map
    ADD CONSTRAINT product_curriculum_map_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.curriculum(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: product_curriculum_map product_curriculum_map_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_curriculum_map
    ADD CONSTRAINT product_curriculum_map_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON UPDATE CASCADE;


--
-- Name: product_relatedproduct_map product_relatedproduct_map_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_relatedproduct_map
    ADD CONSTRAINT product_relatedproduct_map_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON UPDATE CASCADE;


--
-- Name: product_relatedproduct_map product_relatedproduct_map_relatedproduct_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_relatedproduct_map
    ADD CONSTRAINT product_relatedproduct_map_relatedproduct_id_fkey FOREIGN KEY (relatedproduct_id) REFERENCES public.product(id) ON UPDATE CASCADE;


--
-- Name: product_review_map product_review_map_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_review_map
    ADD CONSTRAINT product_review_map_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON UPDATE CASCADE;


--
-- Name: product_review_map product_review_map_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_review_map
    ADD CONSTRAINT product_review_map_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.review(id) ON UPDATE CASCADE;


--
-- Name: review review_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review
    ADD CONSTRAINT review_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE;


--
-- Name: section_lesson_map section_lesson_map_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_lesson_map
    ADD CONSTRAINT section_lesson_map_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lesson(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: section_lesson_map section_lesson_map_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_lesson_map
    ADD CONSTRAINT section_lesson_map_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.section(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: storecategory_product_map storecategory_product_map_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storecategory_product_map
    ADD CONSTRAINT storecategory_product_map_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.storecategory(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: storecategory_product_map storecategory_product_map_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storecategory_product_map
    ADD CONSTRAINT storecategory_product_map_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: study_heatmap_log study_heatmap_log_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_heatmap_log
    ADD CONSTRAINT study_heatmap_log_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lesson(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: study_heatmap_log study_heatmap_log_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_heatmap_log
    ADD CONSTRAINT study_heatmap_log_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: study_heatmap_log study_heatmap_log_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_heatmap_log
    ADD CONSTRAINT study_heatmap_log_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.section(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: study_heatmap_log study_heatmap_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_heatmap_log
    ADD CONSTRAINT study_heatmap_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE;


--
-- Name: tts_requests tts_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_requests
    ADD CONSTRAINT tts_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: tts_saved_files tts_saved_files_tts_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_saved_files
    ADD CONSTRAINT tts_saved_files_tts_request_id_fkey FOREIGN KEY (tts_request_id) REFERENCES public.tts_requests(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: tts_saved_files tts_saved_files_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_saved_files
    ADD CONSTRAINT tts_saved_files_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE;


--
-- PostgreSQL database dump complete
--


