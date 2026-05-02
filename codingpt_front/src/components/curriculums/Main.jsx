// src/components/curriculumList/main
import { useNavigate } from 'react-router-dom';

const Main = ({curriculumList}) => {
  const navigate = useNavigate();
  return (
    <div 
      className="
        w-full h-[calc(100vh-var(--margin-header))]
        mt-header
      "
    >
      <div
        className="
          flex flex-col gap-4
          w-full h-full
          p-4
        "
      >
        <h2 className="
          text-base font-bold
          text-white
        ">언어</h2>
        <ul className="
          flex flex-col gap-4
        ">
          {curriculumList.map((curriculum) => (
          <li 
            key={curriculum.id}
            className="
              flex gap-4
              border border-main rounded-2xl
              p-4
            "
            onClick={() => {
              navigate(`/sections?curriculum_id=${curriculum.id}`);
            }}
          >
            <img 
              src={curriculum.image} 

              alt={curriculum.title} 
              className="
                w-20
              "
            />
            <div className="
              flex flex-col justify-between flex-1
            ">
              <div className="">
                <h3 className="
                  text-white font-bold text-base
                ">{curriculum.title}</h3>
                <p className="
                  text-slate-200 text-xs
                ">{curriculum.description}</p>
              </div>
              <div className="
                bg-main rounded-2xl
                w-full h-3
              ">
              </div>
            </div>
          </li>
          ))}
        </ul>
      </div>

    </div>
  )
}
export default Main;